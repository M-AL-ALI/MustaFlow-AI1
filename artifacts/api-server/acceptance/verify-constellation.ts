// ─────────────────────────────────────────────────────────────────────────────
// Constellation enterprise-lane acceptance (Task #1518).
//
// End-to-end verification against the RUNNING dev api-server (HTTP routes with
// the x-e2e-test-user bypass) plus direct lib calls for the gate/charge/webhook
// internals, using REAL Stripe test-mode objects. api-server Vitest OOMs in
// this environment, so tsx assertion scripts like this one are the gate.
//
// Run:  cd artifacts/api-server && pnpm exec tsx acceptance/verify-constellation.ts
// Exits non-zero on any failed assertion.
// ─────────────────────────────────────────────────────────────────────────────

process.env.CREDITS_ENFORCEMENT = "true"; // live-read by the gate resolver
delete process.env.NABUFLOW_BILLING_TEST_BYPASS; // never test with the bypass on

import { and, eq, isNull } from "drizzle-orm";
import {
  db,
  notificationsTable,
  nabuflowOrgsTable,
  nabuflowOrgSeatsTable,
  nabuflowOrgPurchasesTable,
  nabuflowOrgLedgerTable,
  nabuflowOrgMonthsTable,
  nabuflowOrgSeatMonthsTable,
  nabuflowUsageEventsTable,
} from "@workspace/db";
import {
  nabuflowOrgMonthStart,
  handleNabuflowOrgInvoicePaid,
  handleNabuflowOrgInvoicePaymentFailed,
  isNabuflowOrgInvoiceEvent,
} from "../src/lib/nabuflow-org";
import {
  resolveNabuflowBuildGate,
  maybeChargeNabuflow,
  maybeRefundNabuflow,
} from "../src/lib/nabuflow-billing";
import { requireStripe } from "../src/lib/nabuflow-stripe";

const BASE = "http://localhost:8080/api";
const ts = Date.now();
const ADMIN = `e2e-const-admin-${ts}`;
const SEAT = `e2e-const-seat-${ts}`;
const OUTSIDER = `e2e-const-out-${ts}`;
const COMPANY = `E2E Constellation Corp ${ts}`;

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) {
    pass++;
    console.log(`  OK   ${name}`);
  } else {
    fail++;
    console.error(`  FAIL ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`);
  }
}

async function api(
  user: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: any }> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { "x-e2e-test-user": user, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json: any = null;
  try {
    json = await res.json();
  } catch {
    /* non-JSON */
  }
  return { status: res.status, json };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  console.log(`\n═══ Constellation acceptance — admin=${ADMIN} ═══\n`);
  const stripe = await requireStripe();

  // ── A. Registration ────────────────────────────────────────────────────────
  console.log("A. Company registration (gated setup)");
  {
    const r0 = await api(ADMIN, "GET", "/billing/nabuflow/org");
    check("fresh user GET /org → 404 not_in_org", r0.status === 404 && r0.json?.code === "not_in_org", r0);

    const reg = await api(ADMIN, "POST", "/billing/nabuflow/org", {
      companyName: COMPANY,
      billingContactName: "Pat Procurement",
      billingContactEmail: `billing+${ts}@e2e-constellation.test`,
      taxId: "EU123456789",
      addressLine1: "1 Enterprise Way",
      city: "Metropolis",
      region: "CA",
      postalCode: "94000",
      country: "us", // must uppercase
    });
    check("register → 201", reg.status === 201, reg);
    check("registered org shape", reg.json?.org?.companyName === COMPANY && reg.json?.org?.status === "active", reg.json?.org);
    check("requester seated as billing_admin", reg.json?.role === "billing_admin");
    check("pool starts empty", reg.json?.org?.poolCredits === 0);
    check("terms disabled by default", reg.json?.org?.invoiceTermsEnabled === false);
    check("default org cap $1000", reg.json?.org?.effectiveSpendCapUsdCents === 100_000, reg.json?.org?.effectiveSpendCapUsdCents);
    check("country uppercased", reg.json?.org?.country === "US");

    const dup = await api(ADMIN, "POST", "/billing/nabuflow/org", {
      companyName: "Dup Co",
      billingContactEmail: `dup+${ts}@e2e.test`,
      addressLine1: "2 Dup St",
      city: "Dupville",
      postalCode: "00001",
      country: "US",
    });
    check("second register → 409 already_in_org", dup.status === 409 && dup.json?.code === "already_in_org", dup);
  }

  const [orgRow] = await db.select().from(nabuflowOrgsTable).where(eq(nabuflowOrgsTable.companyName, COMPANY)).limit(1);
  check("org row persisted", !!orgRow);
  if (!orgRow) throw new Error("org row missing — cannot continue");
  const orgId = orgRow.id;
  const custId = orgRow.stripeCustomerId!;
  check("org has company Stripe customer id", typeof custId === "string" && custId.startsWith("cus_"));

  // Company-flagged customer (organization entity, never a personal customer)
  {
    const cust = (await stripe.customers.retrieve(custId)) as any;
    check("customer name = company", cust.name === COMPANY);
    check("customer metadata surface=nabuflow", cust.metadata?.surface === "nabuflow");
    check("customer metadata entity=organization", cust.metadata?.entity === "organization");
    check("customer metadata tax_id captured", cust.metadata?.tax_id === "EU123456789");
    check("customer billing address captured", cust.address?.line1 === "1 Enterprise Way" && cust.address?.country === "US");
    let linked = false;
    for (let i = 0; i < 10 && !linked; i++) {
      const c = (await stripe.customers.retrieve(custId)) as any;
      linked = c.metadata?.org_id === String(orgId);
      if (!linked) await sleep(500);
    }
    check("customer back-linked with org_id", linked);
  }

  // ── B. Pricing & bulk purchases ────────────────────────────────────────────
  console.log("\nB. Volume pricing & bulk purchases");
  {
    const p = await api(ADMIN, "GET", "/billing/nabuflow/org/pricing");
    check("pricing: min 25,000 credits", p.json?.minPurchaseCredits === 25_000, p.json);
    check("pricing: self-serve rate $0.010", p.json?.selfServeRateUsdPerCredit === 0.01);
    const tiers = p.json?.tiers ?? [];
    check(
      "pricing: 3 volume tiers below self-serve",
      tiers.length === 3 &&
        tiers[0]?.minCredits === 25_000 && tiers[0]?.usdPerCredit === 0.009 &&
        tiers[1]?.minCredits === 100_000 && tiers[1]?.usdPerCredit === 0.008 &&
        tiers[2]?.minCredits === 500_000 && tiers[2]?.usdPerCredit === 0.007,
      tiers,
    );

    const below = await api(ADMIN, "POST", "/billing/nabuflow/org/purchase", { credits: 10_000, method: "card" });
    check("below minimum → 400 below_minimum", below.status === 400 && below.json?.code === "below_minimum", below);

    const terms = await api(ADMIN, "POST", "/billing/nabuflow/org/purchase", { credits: 25_000, method: "invoice" });
    check("invoice w/o terms → 402 terms_not_enabled", terms.status === 402 && terms.json?.code === "terms_not_enabled", terms);

    // No company card yet → friendly pre-charge block, purchase marked failed
    const noCard = await api(ADMIN, "POST", "/billing/nabuflow/org/purchase", { credits: 25_000, method: "card" });
    check("card purchase w/o card → 402 no_payment_method", noCard.status === 402 && noCard.json?.code === "no_payment_method", noCard);
    const failedRows = await db
      .select()
      .from(nabuflowOrgPurchasesTable)
      .where(and(eq(nabuflowOrgPurchasesTable.orgId, orgId), eq(nabuflowOrgPurchasesTable.status, "failed")));
    check("no-card purchase marked failed, never credited", failedRows.length === 1 && failedRows[0].creditedAt === null, failedRows.length);
    const org1 = await db.select().from(nabuflowOrgsTable).where(eq(nabuflowOrgsTable.id, orgId)).limit(1);
    check("pool untouched after no-card block", org1[0].poolCredits === 0);

    // Real decline: card on file but charge refused → invoice voided, purchase failed
    // This test PM attaches successfully but every charge attempt fails.
    const badPm = await stripe.paymentMethods.attach("pm_card_chargeCustomerFail", { customer: custId });
    await stripe.customers.update(custId, { invoice_settings: { default_payment_method: badPm.id } });
    const declined = await api(ADMIN, "POST", "/billing/nabuflow/org/purchase", { credits: 25_000, method: "card" });
    check("declined card → payment_failed", declined.status >= 400 && declined.json?.code === "payment_failed", declined);
    const failedRows2 = await db
      .select()
      .from(nabuflowOrgPurchasesTable)
      .where(and(eq(nabuflowOrgPurchasesTable.orgId, orgId), eq(nabuflowOrgPurchasesTable.status, "failed")));
    check("declined purchase marked failed, never credited", failedRows2.length === 2 && failedRows2.every((p) => p.creditedAt === null), failedRows2.length);
    // Failed purchases don't keep an invoice ref — verify the invariant at the
    // source: the customer must have NO collectible (open/draft) invoice left.
    const custInvoices = (await stripe.invoices.list({ customer: custId, limit: 20 })) as any;
    check(
      "declined invoice voided (no dangling collectible invoice)",
      custInvoices.data.length === 1 && custInvoices.data.every((i: any) => i.status === "void"),
      custInvoices.data.map((i: any) => i.status),
    );
    const org2 = await db.select().from(nabuflowOrgsTable).where(eq(nabuflowOrgsTable.id, orgId)).limit(1);
    check("pool untouched after decline", org2[0].poolCredits === 0);
  }

  // SetupIntent route exists for the browser card flow; attach test card via SDK.
  {
    const si = await api(ADMIN, "POST", "/billing/nabuflow/org/setup-intent");
    check("org setup-intent → clientSecret", si.status === 200 && typeof si.json?.clientSecret === "string" && si.json.clientSecret.startsWith("seti_"), si.status);
    const pm = await stripe.paymentMethods.attach("pm_card_visa", { customer: custId });
    await stripe.customers.update(custId, { invoice_settings: { default_payment_method: pm.id } });
  }

  let expectedPool = 0;
  {
    const buy1 = await api(ADMIN, "POST", "/billing/nabuflow/org/purchase", {
      credits: 25_000,
      method: "card",
      poReference: "PO-E2E-001",
    });
    expectedPool += 25_000;
    check("25k card purchase → 201 paid", buy1.status === 201 && buy1.json?.purchase?.status === "paid", buy1);
    check("25k priced at tier $0.009 = $225.00", buy1.json?.purchase?.amountUsdCents === 22_500, buy1.json?.purchase);
    check("pool funded immediately (card)", buy1.json?.poolCredits === expectedPool, buy1.json?.poolCredits);
    check("hosted invoice URL returned", typeof buy1.json?.purchase?.hostedInvoiceUrl === "string");

    // Invoice artifacts: human-readable line item + PO/tax custom fields + namespace metadata
    const [p1] = await db
      .select()
      .from(nabuflowOrgPurchasesTable)
      .where(and(eq(nabuflowOrgPurchasesTable.orgId, orgId), eq(nabuflowOrgPurchasesTable.status, "paid")));
    const inv1 = (await stripe.invoices.retrieve(p1.stripeInvoiceId!)) as any;
    check("Stripe invoice paid", inv1.status === "paid");
    check("invoice bills the company customer", (typeof inv1.customer === "string" ? inv1.customer : inv1.customer?.id) === custId);
    const line = inv1.lines?.data?.[0];
    check(
      "line item human-readable (credits @ rate + tier)",
      typeof line?.description === "string" && line.description.includes("25,000 build credits") && line.description.includes("$0.009/credit"),
      line?.description,
    );
    const cf: Array<{ name: string; value: string }> = inv1.custom_fields ?? [];
    check("PO reference printed on invoice", cf.some((f) => f.value === "PO-E2E-001"), cf);
    check("Tax/VAT id printed on invoice", cf.some((f) => f.value === "EU123456789"), cf);
    check("invoice namespaced to enterprise lane", inv1.metadata?.surface === "nabuflow" && inv1.metadata?.purpose === "org_pool_purchase", inv1.metadata);

    // Webhook replay is a no-op (creditedAt latch)
    await handleNabuflowOrgInvoicePaid(inv1);
    const orgAfterReplay = await db.select().from(nabuflowOrgsTable).where(eq(nabuflowOrgsTable.id, orgId)).limit(1);
    check("invoice.paid replay does NOT double-credit", orgAfterReplay[0].poolCredits === expectedPool, orgAfterReplay[0].poolCredits);

    const buy2 = await api(ADMIN, "POST", "/billing/nabuflow/org/purchase", { credits: 100_000, method: "card" });
    expectedPool += 100_000;
    check("100k card purchase hits $0.008 tier = $800.00", buy2.status === 201 && buy2.json?.purchase?.amountUsdCents === 80_000, buy2.json?.purchase);
    check("pool = 125,000 after both purchases", buy2.json?.poolCredits === expectedPool);
  }

  // Webhook routing isolation — org detector must reject non-org invoices
  {
    check("org invoice detected via metadata", await isNabuflowOrgInvoiceEvent({ id: "in_x", metadata: { surface: "nabuflow", purpose: "org_pool_purchase" } } as any));
    check(
      "personal nabuflow invoice NOT org",
      !(await isNabuflowOrgInvoiceEvent({ id: `in_nonexistent_${ts}`, customer: `cus_nonexistent_${ts}`, metadata: { surface: "nabuflow", purpose: "subscription" } } as any)),
    );
    check(
      "Ora-style invoice NOT org",
      !(await isNabuflowOrgInvoiceEvent({ id: `in_ora_${ts}`, customer: `cus_ora_${ts}`, metadata: {} } as any)),
    );
  }

  // ── C. Seats ──────────────────────────────────────────────────────────────
  console.log("\nC. Seats & member visibility");
  {
    const ghost = await api(ADMIN, "POST", "/billing/nabuflow/org/seats", { email: `ghost+${ts}@nowhere.test` });
    check("seat for unknown account → 404 user_not_found", ghost.status === 404 && ghost.json?.code === "user_not_found", ghost);

    // E2E user ids have no Clerk account — seat the member directly (the
    // route's Clerk-lookup happy path is covered in the browser session).
    await db.insert(nabuflowOrgSeatsTable).values({
      orgId,
      userId: SEAT,
      role: "member",
      email: `seat+${ts}@e2e-constellation.test`,
      addedByUserId: ADMIN,
    });

    const seatView = await api(SEAT, "GET", "/billing/nabuflow/org");
    check("seat sees org billing state", seatView.status === 200 && seatView.json?.org?.companyName === COMPANY, seatView.status);
    check("seat role = member", seatView.json?.role === "member");
    check(
      "member does NOT get admin extras",
      !("purchases" in (seatView.json ?? {})) && !("ledger" in (seatView.json ?? {})) && !("card" in (seatView.json ?? {})),
      Object.keys(seatView.json ?? {}),
    );

    const adminView = await api(ADMIN, "GET", "/billing/nabuflow/org");
    check("admin sees seats incl. member", Array.isArray(adminView.json?.seats) && adminView.json.seats.length === 2);
    check("admin sees purchases", Array.isArray(adminView.json?.purchases) && adminView.json.purchases.length >= 3);
    check("admin sees pool ledger", Array.isArray(adminView.json?.ledger) && adminView.json.ledger.length >= 2);
    check("admin sees company card last4", adminView.json?.card?.last4 === "4242", adminView.json?.card);

    const state = await api(SEAT, "GET", "/billing/nabuflow/state");
    check("seat state: plan = constellation", state.json?.plan?.id === "constellation", state.json?.plan?.id);
    check("seat state: org block present", state.json?.org?.companyName === COMPANY && state.json?.org?.poolCredits === expectedPool, state.json?.org);
    check("seat state: no personal subscription", state.json?.subscription === null);

    // Member authz walls
    const patch = await api(SEAT, "PATCH", "/billing/nabuflow/org", { poReference: "PO-NOPE" });
    check("member PATCH org → 403 not_billing_admin", patch.status === 403 && patch.json?.code === "not_billing_admin", patch);
    const mBuy = await api(SEAT, "POST", "/billing/nabuflow/org/purchase", { credits: 25_000, method: "card" });
    check("member purchase → 403", mBuy.status === 403 && mBuy.json?.code === "not_billing_admin");
    const mCap = await api(SEAT, "POST", "/billing/nabuflow/org/spend-cap", { spendCapUsdCents: 1 });
    check("member spend-cap → 403", mCap.status === 403);
    const mSi = await api(SEAT, "POST", "/billing/nabuflow/org/setup-intent");
    check("member setup-intent → 403", mSi.status === 403);
    const mSeat = await api(SEAT, "POST", "/billing/nabuflow/org/seats", { email: "x@y.test" });
    check("member add-seat → 403", mSeat.status === 403);
  }

  // ── D. Gate + pool draws through the SAME charge pipeline ─────────────────
  console.log("\nD. Build gate & shared-pool draws");
  const oraCreditsBefore = await api(SEAT, "GET", "/credits");
  let expectedMonthCredits = 0;
  let expectedMonthCents = 0;
  {
    const gate = await resolveNabuflowBuildGate(SEAT, { engineMode: "pro", deepReasoning: true, projectedCredits: 45 });
    check("seat may build Pro+Deep (Constellation ladder)", gate.allowed === true, gate);

    // Draw #1 — plain Pro build cost (amounts arrive from creditCostFor at call sites)
    const d1 = await maybeChargeNabuflow(SEAT, 10, {
      type: "pipeline",
      description: "E2E org draw — pro build",
      engineMode: "pro",
      deepReasoning: false,
    } as any);
    expectedPool -= 10;
    expectedMonthCredits += 10;
    expectedMonthCents += 10;
    check("pool draw routed through maybeChargeNabuflow", d1?.newBalance === expectedPool, d1);

    // Draw #2 — Deep-surcharged amount flows through identically
    const d2 = await maybeChargeNabuflow(SEAT, 45, {
      type: "pipeline",
      description: "E2E org draw — pro+deep build",
      engineMode: "pro",
      deepReasoning: true,
    } as any);
    expectedPool -= 45;
    expectedMonthCredits += 45;
    expectedMonthCents += 45;
    check("deep-surcharged draw decrements pool exactly", d2?.newBalance === expectedPool);

    const events = await db
      .select()
      .from(nabuflowUsageEventsTable)
      .where(and(eq(nabuflowUsageEventsTable.userId, SEAT), eq(nabuflowUsageEventsTable.orgId, orgId)));
    check("2 usage events on the org lane", events.length === 2);
    const deepEvt = events.find((e) => e.credits === 45);
    check(
      'events: attribution "pool", cycleId NULL, orgId set',
      events.every((e) => e.attribution === "pool" && e.cycleId === null && e.orgId === orgId),
      events.map((e) => ({ a: e.attribution, c: e.cycleId })),
    );
    check("events: draw valued at $0.010/credit", events.every((e) => e.usdValueCents === e.credits), events.map((e) => e.usdValueCents));
    check("events: zero included/overage (pool attribution)", events.every((e) => e.includedCredits === 0 && e.overageCredits === 0));
    check("deep flag recorded on the deep draw", deepEvt?.deepReasoning === true);

    // Seats' builds visible in their usage surface
    const usage = await api(SEAT, "GET", "/billing/nabuflow/usage");
    const blob = JSON.stringify(usage.json ?? {});
    check("usage surface shows pool draws", usage.status === 200 && blob.includes('"pool"'), usage.status);
  }

  // ── E. Caps: org-wide + per-seat, threshold warnings ───────────────────────
  console.log("\nE. Spend caps & threshold warnings");
  {
    const overMax = await api(ADMIN, "POST", "/billing/nabuflow/org/spend-cap", { spendCapUsdCents: 1_000_001 });
    check("org cap above $10,000 max → 400", overMax.status === 400, overMax);

    const setCap = await api(ADMIN, "POST", "/billing/nabuflow/org/spend-cap", { spendCapUsdCents: 100 });
    check("org cap set to $1.00", setCap.status === 200 && setCap.json?.effectiveSpendCapUsdCents === 100);

    // Draw to 65% of cap → 50% warning fires for admins
    await maybeChargeNabuflow(SEAT, 10, { type: "pipeline", description: "E2E threshold draw", engineMode: "pro" } as any);
    expectedPool -= 10;
    expectedMonthCredits += 10;
    expectedMonthCents += 10;
    let warn50 = false;
    for (let i = 0; i < 10 && !warn50; i++) {
      const rows = await db
        .select()
        .from(notificationsTable)
        .where(and(eq(notificationsTable.recipientId, ADMIN), eq(notificationsTable.type, "nabuflow_org_cap_warning")));
      warn50 = rows.length >= 1;
      if (!warn50) await sleep(300);
    }
    check("50% cap warning notified to billing admin", warn50);

    // Gate blocks the NEXT build past the cap — pre-start only
    const blocked = await resolveNabuflowBuildGate(SEAT, { engineMode: "pro", projectedCredits: 40 });
    check("build past org cap blocked pre-start", blocked.allowed === false && (blocked as any).error?.code === "org_spend_cap_reached", blocked);
    const drain = await resolveNabuflowBuildGate(SEAT, { engineMode: "pro", projectedCredits: 40, skipUsageChecks: true });
    check("in-flight drain re-check passes (never killed)", drain.allowed === true);

    // Crossing 100% via an in-flight drain fires the cap-reached warning
    await maybeChargeNabuflow(SEAT, 40, { type: "pipeline", description: "E2E in-flight past cap", engineMode: "pro" } as any);
    expectedPool -= 40;
    expectedMonthCredits += 40;
    expectedMonthCents += 40;
    let warn100 = false;
    for (let i = 0; i < 10 && !warn100; i++) {
      const rows = await db
        .select()
        .from(notificationsTable)
        .where(and(eq(notificationsTable.recipientId, ADMIN), eq(notificationsTable.type, "nabuflow_org_cap_warning")));
      warn100 = rows.length >= 2;
      if (!warn100) await sleep(300);
    }
    check("100% cap-reached warning notified", warn100);

    // Restore default cap; per-seat sub-cap now
    await api(ADMIN, "POST", "/billing/nabuflow/org/spend-cap", { spendCapUsdCents: null });
    const capGhost = await api(ADMIN, "POST", `/billing/nabuflow/org/seats/nope-${ts}/cap`, { seatSpendCapUsdCents: 5 });
    check("seat cap for unknown seat → 404", capGhost.status === 404 && capGhost.json?.code === "seat_not_found");
    const seatCap = await api(ADMIN, "POST", `/billing/nabuflow/org/seats/${SEAT}/cap`, { seatSpendCapUsdCents: 60 });
    check("seat sub-cap set ($0.60)", seatCap.status === 200 && seatCap.json?.seat?.seatSpendCapUsdCents === 60);
    const seatBlocked = await resolveNabuflowBuildGate(SEAT, { engineMode: "pro", projectedCredits: 5 });
    check("seat sub-cap blocks pre-start", seatBlocked.allowed === false && (seatBlocked as any).error?.code === "org_seat_cap_reached", seatBlocked);
    const adminGate = await resolveNabuflowBuildGate(ADMIN, { engineMode: "pro", projectedCredits: 5 });
    check("other seats unaffected by that sub-cap", adminGate.allowed === true, adminGate);
    const clearCap = await api(ADMIN, "POST", `/billing/nabuflow/org/seats/${SEAT}/cap`, { seatSpendCapUsdCents: null });
    check("seat sub-cap cleared", clearCap.status === 200 && clearCap.json?.seat?.seatSpendCapUsdCents === null);
    const unblocked = await resolveNabuflowBuildGate(SEAT, { engineMode: "pro", projectedCredits: 5 });
    check("seat builds again after clearing sub-cap", unblocked.allowed === true);
  }

  // ── F. Pool exhaustion, negative balance, refunds ──────────────────────────
  console.log("\nF. Pool exhaustion & refunds (in-flight never killed)");
  {
    await db.update(nabuflowOrgsTable).set({ poolCredits: 3 }).where(eq(nabuflowOrgsTable.id, orgId));
    const empty = await resolveNabuflowBuildGate(SEAT, { engineMode: "pro", projectedCredits: 40 });
    check("pool too small → org_pool_exhausted", empty.allowed === false && (empty as any).error?.code === "org_pool_exhausted", empty);

    // An already-started build still drains — pool may go negative.
    // Amount 41 is unique across this run so refund matching is unambiguous.
    const inflight = await maybeChargeNabuflow(SEAT, 41, { type: "pipeline", description: "E2E in-flight on empty pool", engineMode: "pro" } as any);
    check("in-flight drain clamps display balance at 0", inflight?.newBalance === 0, inflight);
    const [negOrg] = await db.select().from(nabuflowOrgsTable).where(eq(nabuflowOrgsTable.id, orgId)).limit(1);
    check("pool actually negative (never killed)", negOrg.poolCredits === -38, negOrg.poolCredits);

    // Cancel/discard refund routes back to the pool via the same delegation
    const refunded = await maybeRefundNabuflow(SEAT, 41, { description: "E2E cancel refund" });
    check("refund restores the pool draw", refunded === 3, refunded);
    const reversed = await db
      .select()
      .from(nabuflowUsageEventsTable)
      .where(and(eq(nabuflowUsageEventsTable.userId, SEAT), eq(nabuflowUsageEventsTable.orgId, orgId)));
    check("exactly one draw reversed", reversed.filter((e) => e.reversedAt !== null).length === 1);
    const dup = await maybeRefundNabuflow(SEAT, 41, { description: "E2E duplicate refund" });
    check("duplicate refund is a no-op", dup === 3, dup);

    const out = await maybeRefundNabuflow(OUTSIDER, 41, { description: "outsider" });
    check("non-seat refund untouched by org lane", out === null, out);

    await db.update(nabuflowOrgsTable).set({ poolCredits: expectedPool }).where(eq(nabuflowOrgsTable.id, orgId));
  }

  // ── G. Suspension ──────────────────────────────────────────────────────────
  console.log("\nG. Suspension");
  {
    await db.update(nabuflowOrgsTable).set({ status: "suspended" }).where(eq(nabuflowOrgsTable.id, orgId));
    const s1 = await resolveNabuflowBuildGate(SEAT, { engineMode: "pro", projectedCredits: 1 });
    check("suspended org blocks new builds", s1.allowed === false && (s1 as any).error?.code === "org_suspended", s1);
    const s2 = await resolveNabuflowBuildGate(SEAT, { engineMode: "pro", projectedCredits: 1, skipUsageChecks: true });
    check("suspension blocks even drain re-checks", s2.allowed === false && (s2 as any).error?.code === "org_suspended");
    await db.update(nabuflowOrgsTable).set({ status: "active" }).where(eq(nabuflowOrgsTable.id, orgId));
  }

  // ── H. Invoice-with-terms (net-N) flow ─────────────────────────────────────
  console.log("\nH. Company invoicing with terms (net-45)");
  {
    const gatePatch = await api(ADMIN, "PATCH", "/billing/nabuflow/org", { invoiceTermsEnabled: true });
    check("terms toggle is platform-gated → 403", gatePatch.status === 403 && gatePatch.json?.code === "terms_platform_gated", gatePatch);

    // Platform (superuser) grants terms — simulated at the DB layer here
    await db.update(nabuflowOrgsTable).set({ invoiceTermsEnabled: true }).where(eq(nabuflowOrgsTable.id, orgId));
    const patch = await api(ADMIN, "PATCH", "/billing/nabuflow/org", { termsNetDays: 45, poReference: "PO-STANDING-9" });
    check("admin updates net days + standing PO", patch.status === 200 && patch.json?.org?.termsNetDays === 45 && patch.json?.org?.poReference === "PO-STANDING-9", patch.json?.org);

    const buy = await api(ADMIN, "POST", "/billing/nabuflow/org/purchase", { credits: 25_000, method: "invoice" });
    check("terms purchase → 201 pending", buy.status === 201 && buy.json?.purchase?.status === "pending", buy);
    check("pool NOT funded until invoice.paid", buy.json?.poolCredits === expectedPool, buy.json?.poolCredits);
    const dueAt = buy.json?.purchase?.dueAt ? new Date(buy.json.purchase.dueAt) : null;
    const days = dueAt ? Math.round((dueAt.getTime() - Date.now()) / 86_400_000) : -1;
    check("due date ≈ net-45", days >= 44 && days <= 46, days);

    const [pRow] = await db
      .select()
      .from(nabuflowOrgPurchasesTable)
      .where(and(eq(nabuflowOrgPurchasesTable.orgId, orgId), eq(nabuflowOrgPurchasesTable.status, "pending")));
    const inv = (await stripe.invoices.retrieve(pRow.stripeInvoiceId!)) as any;
    // Finalized invoices expose due_date (epoch seconds), not days_until_due.
    const invDueDays = inv.due_date ? Math.round((inv.due_date * 1000 - Date.now()) / 86_400_000) : -1;
    check("Stripe invoice open + send_invoice + net-45", inv.status === "open" && inv.collection_method === "send_invoice" && invDueDays >= 44 && invDueDays <= 46, {
      s: inv.status,
      c: inv.collection_method,
      d: invDueDays,
    });
    check("standing PO printed on terms invoice", (inv.custom_fields ?? []).some((f: any) => f.value === "PO-STANDING-9"), inv.custom_fields);

    // invoice.paid webhook funds the pool exactly once
    await handleNabuflowOrgInvoicePaid(inv);
    expectedPool += 25_000;
    let [orgNow] = await db.select().from(nabuflowOrgsTable).where(eq(nabuflowOrgsTable.id, orgId)).limit(1);
    check("webhook funds pool on invoice.paid", orgNow.poolCredits === expectedPool, orgNow.poolCredits);
    await handleNabuflowOrgInvoicePaid(inv);
    [orgNow] = await db.select().from(nabuflowOrgsTable).where(eq(nabuflowOrgsTable.id, orgId)).limit(1);
    check("webhook replay idempotent (terms path)", orgNow.poolCredits === expectedPool);
    const [paidRow] = await db.select().from(nabuflowOrgPurchasesTable).where(eq(nabuflowOrgPurchasesTable.id, pRow.id)).limit(1);
    check("purchase marked paid with paidAt", paidRow.status === "paid" && paidRow.paidAt !== null);

    // Dunning on the enterprise lane: failed → admins told → later payment recovers
    const buy2 = await api(ADMIN, "POST", "/billing/nabuflow/org/purchase", { credits: 25_000, method: "invoice" });
    const [pRow2] = await db
      .select()
      .from(nabuflowOrgPurchasesTable)
      .where(and(eq(nabuflowOrgPurchasesTable.orgId, orgId), eq(nabuflowOrgPurchasesTable.status, "pending")));
    check("second terms purchase pending", buy2.status === 201 && !!pRow2);
    const inv2 = (await stripe.invoices.retrieve(pRow2.stripeInvoiceId!)) as any;
    await handleNabuflowOrgInvoicePaymentFailed(inv2);
    const [failedRow] = await db.select().from(nabuflowOrgPurchasesTable).where(eq(nabuflowOrgPurchasesTable.id, pRow2.id)).limit(1);
    check("payment_failed marks purchase failed, pool untouched", failedRow.status === "failed" && failedRow.creditedAt === null);
    const failNote = await db
      .select()
      .from(notificationsTable)
      .where(and(eq(notificationsTable.recipientId, ADMIN), eq(notificationsTable.type, "nabuflow_org_purchase_failed")));
    check("admins notified of failed payment", failNote.length >= 1);
    await handleNabuflowOrgInvoicePaid(inv2); // retry succeeds later
    expectedPool += 25_000;
    const [recovered] = await db.select().from(nabuflowOrgPurchasesTable).where(eq(nabuflowOrgPurchasesTable.id, pRow2.id)).limit(1);
    check("late payment recovers the purchase", recovered.status === "paid" && recovered.creditedAt !== null);
    const fundedNote = await db
      .select()
      .from(notificationsTable)
      .where(and(eq(notificationsTable.recipientId, ADMIN), eq(notificationsTable.type, "nabuflow_org_pool_funded")));
    check("admins notified when pool funded", fundedNote.length >= 1);
  }

  // ── I. Reconciliation: pool = purchases − draws + reversals ───────────────
  console.log("\nI. Ledger / usage / invoice reconciliation");
  {
    const [orgFinal] = await db.select().from(nabuflowOrgsTable).where(eq(nabuflowOrgsTable.id, orgId)).limit(1);
    check("final pool matches running expectation", orgFinal.poolCredits === expectedPool, { actual: orgFinal.poolCredits, expectedPool });

    const ledger = await db.select().from(nabuflowOrgLedgerTable).where(eq(nabuflowOrgLedgerTable.orgId, orgId));
    const ledgerSum = ledger.reduce((s, l) => s + l.credits, 0);
    check("ledger sums to the pool balance", ledgerSum === orgFinal.poolCredits, { ledgerSum });
    const lastByCreated = [...ledger].sort((a, b) => a.id - b.id).at(-1);
    check("last ledger balanceAfter = pool", lastByCreated?.balanceAfter === orgFinal.poolCredits);
    check(
      "ledger entry types complete",
      ledger.some((l) => l.entryType === "purchase") && ledger.some((l) => l.entryType === "draw") && ledger.some((l) => l.entryType === "reversal"),
    );

    const monthStart = nabuflowOrgMonthStart(new Date());
    const [month] = await db
      .select()
      .from(nabuflowOrgMonthsTable)
      .where(and(eq(nabuflowOrgMonthsTable.orgId, orgId), eq(nabuflowOrgMonthsTable.monthStart, monthStart)));
    check("org month credits reconcile", month?.creditsDrawn === expectedMonthCredits, { actual: month?.creditsDrawn, expectedMonthCredits });
    check("org month cents reconcile", month?.drawnUsdCents === expectedMonthCents, { actual: month?.drawnUsdCents, expectedMonthCents });

    const [seatMonth] = await db
      .select()
      .from(nabuflowOrgSeatMonthsTable)
      .where(
        and(
          eq(nabuflowOrgSeatMonthsTable.orgId, orgId),
          eq(nabuflowOrgSeatMonthsTable.userId, SEAT),
          eq(nabuflowOrgSeatMonthsTable.monthStart, monthStart),
        ),
      );
    check("seat month mirrors seat draws", seatMonth?.creditsDrawn === expectedMonthCredits && seatMonth?.drawnUsdCents === expectedMonthCents, seatMonth);

    const liveEvents = await db
      .select()
      .from(nabuflowUsageEventsTable)
      .where(and(eq(nabuflowUsageEventsTable.orgId, orgId), isNull(nabuflowUsageEventsTable.reversedAt)));
    const eventSum = liveEvents.reduce((s, e) => s + e.credits, 0);
    check("non-reversed usage events = month counters", eventSum === expectedMonthCredits, { eventSum });

    const purchases = await db.select().from(nabuflowOrgPurchasesTable).where(eq(nabuflowOrgPurchasesTable.orgId, orgId));
    const creditedSum = purchases.filter((p) => p.creditedAt !== null).reduce((s, p) => s + p.credits, 0);
    check("credited purchases − draws + reversals = pool", creditedSum - expectedMonthCredits === orgFinal.poolCredits, { creditedSum });
    check(
      "purchase amounts match tier math exactly",
      purchases.every((p) => (p.credits === 25_000 ? p.amountUsdCents === 22_500 : p.credits === 100_000 ? p.amountUsdCents === 80_000 : false)),
      purchases.map((p) => [p.credits, p.amountUsdCents]),
    );
  }

  // ── J. Ora independence ────────────────────────────────────────────────────
  console.log("\nJ. Ora independence");
  {
    const oraAfter = await api(SEAT, "GET", "/credits");
    check(
      "Ora credit balance untouched by org lane",
      JSON.stringify(oraCreditsBefore.json?.balance ?? oraCreditsBefore.json) === JSON.stringify(oraAfter.json?.balance ?? oraAfter.json),
      { before: oraCreditsBefore.json, after: oraAfter.json },
    );
  }

  // ── K. Seat lifecycle guards ───────────────────────────────────────────────
  console.log("\nK. Seat lifecycle");
  {
    const lastAdmin = await api(ADMIN, "DELETE", `/billing/nabuflow/org/seats/${ADMIN}`);
    check("last billing admin cannot be removed", lastAdmin.status === 400 && lastAdmin.json?.code === "last_billing_admin", lastAdmin);
    const rm = await api(ADMIN, "DELETE", `/billing/nabuflow/org/seats/${SEAT}`);
    check("member seat removed", rm.status === 200 && rm.json?.ok === true);
    const gone = await api(SEAT, "GET", "/billing/nabuflow/org");
    check("removed seat loses org access", gone.status === 404 && gone.json?.code === "not_in_org");
    const personal = await resolveNabuflowBuildGate(SEAT, { engineMode: "pro", projectedCredits: 1 });
    check("removed seat falls back to personal lane (no_plan)", personal.allowed === false && (personal as any).error?.code === "no_plan", personal);
  }

  console.log(`\n═══ Result: ${pass} passed, ${fail} failed ═══`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
