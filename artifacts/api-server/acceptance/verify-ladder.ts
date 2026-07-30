// ─────────────────────────────────────────────────────────────────────────────
// NabuFlow engine-mode access-ladder acceptance (Task #1518 — brief revision).
//
// Walks the personal-lane ladder end-to-end with REAL cycle accounting and
// Stripe test-mode overage invoice items:
//   • Orbit's 4th Pro build blocked pre-start (calm prompt, counter + reset)
//   • Comet's 11th Deep build blocked prompting Nova
//   • Orbit cannot enable Deep; Pro+Deep is Nova-exclusive
//   • Counters reset on a simulated cycle rollover (incl. rollover credits)
//   • Counter math reconciles with the usage/state API and invoice items
//
// Run:  cd artifacts/api-server && pnpm exec tsx acceptance/verify-ladder.ts
// ─────────────────────────────────────────────────────────────────────────────

process.env.CREDITS_ENFORCEMENT = "true"; // live-read by the gate resolver
delete process.env.NABUFLOW_BILLING_TEST_BYPASS;

import { and, eq, isNull } from "drizzle-orm";
import {
  db,
  nabuflowSubscriptionsTable,
  nabuflowBillingCyclesTable,
  nabuflowUsageEventsTable,
} from "@workspace/db";
import {
  resolveNabuflowBuildGate,
  maybeChargeNabuflow,
  maybeRefundNabuflow,
  computeNabuflowRollover,
  getNabuflowSubscription,
} from "../src/lib/nabuflow-billing";
import { NABUFLOW_PLANS } from "../src/lib/nabuflow-plans";
import { requireStripe } from "../src/lib/nabuflow-stripe";

const BASE = "http://localhost:8080/api";
const ts = Date.now();
const ORBIT = `e2e-lad-orbit-${ts}`;
const COMET = `e2e-lad-comet-${ts}`;
const NOVA = `e2e-lad-nova-${ts}`;

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

async function api(user: string, method: string, path: string, body?: unknown) {
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
const DAY = 24 * 60 * 60_000;

async function seedSub(userId: string, planId: string): Promise<{ start: Date; end: Date }> {
  const start = new Date(Date.now() - 5 * DAY);
  const end = new Date(start.getTime() + 30 * DAY);
  await db.insert(nabuflowSubscriptionsTable).values({
    userId,
    planId,
    status: "active",
    currentCycleStart: start,
    currentCycleEnd: end,
    defaultPaymentMethodId: `pm_e2e_${userId}`,
    cardBrand: "visa",
    cardLast4: "4242",
    cardExpMonth: 12,
    cardExpYear: 2035,
  });
  return { start, end };
}

const gateErr = (d: any) => (d.allowed ? null : d.error);

async function main(): Promise<void> {
  console.log(`\n═══ Ladder acceptance — ${ORBIT} ═══\n`);
  const stripe = await requireStripe();

  // ── A. Plan / card / dunning gates precede the ladder ─────────────────────
  console.log("A. No-plan, card-on-file and dunning gates");
  {
    const noPlan = await resolveNabuflowBuildGate(ORBIT, { engineMode: "eco", projectedCredits: 5 });
    check("no plan → no_plan block", !noPlan.allowed && gateErr(noPlan)?.code === "no_plan", noPlan);

    // Active sub but NO card on file → hard block
    await db.insert(nabuflowSubscriptionsTable).values({
      userId: ORBIT,
      planId: "orbit",
      status: "active",
      currentCycleStart: new Date(Date.now() - 5 * DAY),
      currentCycleEnd: new Date(Date.now() + 25 * DAY),
    });
    const noCard = await resolveNabuflowBuildGate(ORBIT, { engineMode: "eco", projectedCredits: 5 });
    check("no card on file → no_payment_method", !noCard.allowed && gateErr(noCard)?.code === "no_payment_method", noCard);

    await db
      .update(nabuflowSubscriptionsTable)
      .set({ defaultPaymentMethodId: "pm_e2e_expired", cardExpMonth: 1, cardExpYear: 2024 })
      .where(eq(nabuflowSubscriptionsTable.userId, ORBIT));
    const expired = await resolveNabuflowBuildGate(ORBIT, { engineMode: "eco", projectedCredits: 5 });
    check("expired card → card_expired", !expired.allowed && gateErr(expired)?.code === "card_expired", expired);

    await db
      .update(nabuflowSubscriptionsTable)
      .set({ cardBrand: "visa", cardLast4: "4242", cardExpMonth: 12, cardExpYear: 2035 })
      .where(eq(nabuflowSubscriptionsTable.userId, ORBIT));
    const ok = await resolveNabuflowBuildGate(ORBIT, { engineMode: "eco", projectedCredits: 5 });
    check("valid card → allowed", ok.allowed === true, ok);

    await db
      .update(nabuflowSubscriptionsTable)
      .set({ dunningStatus: "paused" })
      .where(eq(nabuflowSubscriptionsTable.userId, ORBIT));
    const paused = await resolveNabuflowBuildGate(ORBIT, { engineMode: "eco", projectedCredits: 5 });
    check("dunning paused → billing_paused", !paused.allowed && gateErr(paused)?.code === "billing_paused", paused);
    await db
      .update(nabuflowSubscriptionsTable)
      .set({ dunningStatus: "none" })
      .where(eq(nabuflowSubscriptionsTable.userId, ORBIT));
  }

  // ── B. Orbit: 3 Pro builds per cycle, no Deep ──────────────────────────────
  console.log("\nB. Orbit ladder walk (3 Pro / no Deep)");
  const orbitSub0 = await getNabuflowSubscription(ORBIT);
  const orbitResetsAt = orbitSub0!.currentCycleEnd!.toISOString();
  {
    const s0 = await api(ORBIT, "GET", "/billing/nabuflow/state");
    check("state: fresh cycle counter 3 remaining", s0.json?.cycle?.remainingProBuilds === 3 && s0.json?.cycle?.proBuildsUsed === 0, s0.json?.cycle);
    check("state: reset date visible", s0.json?.cycle?.resetsAt === orbitResetsAt, s0.json?.cycle?.resetsAt);

    // Orbit cannot enable Deep at all
    const deep = await resolveNabuflowBuildGate(ORBIT, { engineMode: "eco", deepReasoning: true, projectedCredits: 15 });
    check("Orbit Deep → mode_not_available", !deep.allowed && gateErr(deep)?.code === "mode_not_available", deep);
    check("Deep block hints an upgrade", typeof gateErr(deep)?.upgradeTarget === "string" && !!gateErr(deep)?.upgradeTarget);
    const proDeep = await resolveNabuflowBuildGate(ORBIT, { engineMode: "pro", deepReasoning: true, projectedCredits: 45 });
    check("Orbit Pro+Deep blocked too", !proDeep.allowed, proDeep);

    // Three Pro builds pass and tick the counter
    for (let i = 1; i <= 3; i++) {
      const g = await resolveNabuflowBuildGate(ORBIT, { engineMode: "pro", projectedCredits: 10 });
      check(`Pro build #${i} allowed`, g.allowed === true, g);
      await maybeChargeNabuflow(ORBIT, 10, { type: "build", description: `E2E orbit pro #${i}`, engineMode: "pro" });
      const s = await api(ORBIT, "GET", "/billing/nabuflow/state");
      check(`counter after #${i}: ${3 - i} remaining`, s.json?.cycle?.remainingProBuilds === 3 - i && s.json?.cycle?.proBuildsUsed === i, s.json?.cycle);
    }

    // The 4th Pro build is blocked PRE-START with the calm upgrade prompt
    const fourth = await resolveNabuflowBuildGate(ORBIT, { engineMode: "pro", projectedCredits: 10 });
    const e4 = gateErr(fourth);
    check("4th Pro build blocked pre-start", !fourth.allowed && e4?.code === "mode_limit_reached", fourth);
    check("block shows 0 remaining", e4?.remainingProBuilds === 0);
    check("block shows the reset date", e4?.resetsAt === orbitResetsAt, e4?.resetsAt);
    check("calm copy mentions limit + reset", /used all 3 Pro builds/.test(e4?.message ?? "") && /reset/i.test(e4?.message ?? ""), e4?.message);
    check("upgrade prompt targets Comet", e4?.upgradeTarget === "comet", e4?.upgradeTarget);

    // Non-Pro modes unaffected; drain re-checks never block
    const power = await resolveNabuflowBuildGate(ORBIT, { engineMode: "power", projectedCredits: 10 });
    check("Power still allowed at Pro limit", power.allowed === true);
    const drain = await resolveNabuflowBuildGate(ORBIT, { engineMode: "pro", projectedCredits: 10, skipUsageChecks: true });
    check("reserved build drain re-check passes", drain.allowed === true);

    // Refund (canceled build) releases a Pro slot; counter math stays exact
    const refund = await maybeRefundNabuflow(ORBIT, 10, { description: "E2E cancel pro build" });
    check("refund returns remaining bucket", refund !== null && refund! > 0, refund);
    const sAfterRefund = await api(ORBIT, "GET", "/billing/nabuflow/state");
    check("refund releases a Pro slot (counter 2/3)", sAfterRefund.json?.cycle?.proBuildsUsed === 2 && sAfterRefund.json?.cycle?.remainingProBuilds === 1, sAfterRefund.json?.cycle);
    const again = await resolveNabuflowBuildGate(ORBIT, { engineMode: "pro", projectedCredits: 10 });
    check("Pro build allowed again after refund", again.allowed === true);
    await maybeChargeNabuflow(ORBIT, 10, { type: "build", description: "E2E orbit pro #4 (re-book)", engineMode: "pro" });
    const reblocked = await resolveNabuflowBuildGate(ORBIT, { engineMode: "pro", projectedCredits: 10 });
    check("back at 3/3 → blocked again", !reblocked.allowed && gateErr(reblocked)?.code === "mode_limit_reached");

    // Non-build work (architect/senses) never ticks the ladder
    await maybeChargeNabuflow(ORBIT, 5, { type: "architect", description: "E2E architect advice" });
    const sArch = await api(ORBIT, "GET", "/billing/nabuflow/state");
    check("architect charge does not tick Pro counter", sArch.json?.cycle?.proBuildsUsed === 3, sArch.json?.cycle);
  }

  // ── C. Comet: 10 Deep builds per cycle, no combo ───────────────────────────
  console.log("\nC. Comet ladder walk (10 Deep / no Pro+Deep combo)");
  const cometSeed = await seedSub(COMET, "comet");
  {
    const combo = await resolveNabuflowBuildGate(COMET, { engineMode: "pro", deepReasoning: true, projectedCredits: 45 });
    const ec = gateErr(combo);
    check("Comet Pro+Deep → combo_not_available", !combo.allowed && ec?.code === "combo_not_available", combo);
    check("combo block prompts Nova", ec?.upgradeTarget === "nova" && /Nova/.test(ec?.message ?? ""), ec);

    for (let i = 1; i <= 10; i++) {
      const g = await resolveNabuflowBuildGate(COMET, { engineMode: "power", deepReasoning: true, projectedCredits: 15 });
      check(`Deep build #${i} allowed`, g.allowed === true, g);
      await maybeChargeNabuflow(COMET, 15, { type: "build", description: `E2E comet deep #${i}`, engineMode: "power", deepReasoning: true });
    }
    const s10 = await api(COMET, "GET", "/billing/nabuflow/state");
    check("counter shows 10/10 Deep used", s10.json?.cycle?.deepBuildsUsed === 10 && s10.json?.cycle?.remainingDeepBuilds === 0, s10.json?.cycle);

    const eleventh = await resolveNabuflowBuildGate(COMET, { engineMode: "power", deepReasoning: true, projectedCredits: 15 });
    const e11 = gateErr(eleventh);
    check("11th Deep build blocked pre-start", !eleventh.allowed && e11?.code === "mode_limit_reached", eleventh);
    check("block shows 0 Deep remaining + reset", e11?.remainingDeepBuilds === 0 && e11?.resetsAt === cometSeed.end.toISOString(), e11);
    check("calm copy: used all 10 Deep builds", /used all 10 Deep builds/.test(e11?.message ?? ""), e11?.message);
    check("upgrade prompt targets Nova", e11?.upgradeTarget === "nova", e11?.upgradeTarget);

    const proStill = await resolveNabuflowBuildGate(COMET, { engineMode: "pro", projectedCredits: 10 });
    check("Comet Pro is unlimited (allowed at Deep limit)", proStill.allowed === true, proStill);
    const plain = await resolveNabuflowBuildGate(COMET, { engineMode: "power", projectedCredits: 10 });
    check("non-Deep builds unaffected", plain.allowed === true);
  }

  // ── D. Nova: Pro+Deep exclusive ────────────────────────────────────────────
  console.log("\nD. Nova exclusivity");
  {
    await seedSub(NOVA, "nova");
    const combo = await resolveNabuflowBuildGate(NOVA, { engineMode: "pro", deepReasoning: true, projectedCredits: 45 });
    check("Nova Pro+Deep allowed", combo.allowed === true, combo);
    await maybeChargeNabuflow(NOVA, 45, { type: "build", description: "E2E nova pro+deep", engineMode: "pro", deepReasoning: true });
    const s = await api(NOVA, "GET", "/billing/nabuflow/state");
    check("Nova counters unlimited (null remaining)", s.json?.cycle?.remainingProBuilds === null && s.json?.cycle?.remainingDeepBuilds === null, s.json?.cycle);
    check("Nova counters still tracked", s.json?.cycle?.proBuildsUsed === 1 && s.json?.cycle?.deepBuildsUsed === 1, s.json?.cycle);
  }

  // ── E. Simulated cycle rollover resets counters ────────────────────────────
  console.log("\nE. Cycle rollover (counters reset, rollover credits honored)");
  {
    // Orbit: push the whole cycle window into the past → next gate call lazily
    // advances the anchor exactly like a renewal boundary would.
    const subBefore = await getNabuflowSubscription(ORBIT);
    const [oldCycle] = await db
      .select()
      .from(nabuflowBillingCyclesTable)
      .where(and(eq(nabuflowBillingCyclesTable.userId, ORBIT), eq(nabuflowBillingCyclesTable.cycleStart, subBefore!.currentCycleStart!)));
    const shiftedStart = new Date(subBefore!.currentCycleStart!.getTime() - 31 * DAY);
    const shiftedEnd = new Date(subBefore!.currentCycleEnd!.getTime() - 31 * DAY);
    await db
      .update(nabuflowSubscriptionsTable)
      .set({ currentCycleStart: shiftedStart, currentCycleEnd: shiftedEnd })
      .where(eq(nabuflowSubscriptionsTable.userId, ORBIT));
    await db
      .update(nabuflowBillingCyclesTable)
      .set({ cycleStart: shiftedStart, cycleEnd: shiftedEnd })
      .where(eq(nabuflowBillingCyclesTable.id, oldCycle.id));

    const afterRoll = await resolveNabuflowBuildGate(ORBIT, { engineMode: "pro", projectedCredits: 10 });
    check("Orbit Pro allowed again after rollover", afterRoll.allowed === true, afterRoll);
    const sRoll = await api(ORBIT, "GET", "/billing/nabuflow/state");
    check("fresh cycle: counters reset to 0/3", sRoll.json?.cycle?.proBuildsUsed === 0 && sRoll.json?.cycle?.remainingProBuilds === 3, sRoll.json?.cycle);
    check("Orbit rollover policy: no credits carry", sRoll.json?.cycle?.includedCredits === NABUFLOW_PLANS.orbit.includedMonthlyCredits, sRoll.json?.cycle?.includedCredits);
    const subAfter = await getNabuflowSubscription(ORBIT);
    check("anchor advanced beyond now", subAfter!.currentCycleEnd!.getTime() > Date.now());
    const [oldRow] = await db
      .select()
      .from(nabuflowBillingCyclesTable)
      .where(eq(nabuflowBillingCyclesTable.id, oldCycle.id));
    check("old cycle history intact (3 Pro used)", oldRow.proBuildsUsed === 3 && oldRow.usedIncludedCredits === oldCycle.usedIncludedCredits);

    // Comet: unused included credits roll ONE cycle (capped) and Deep resets.
    const cometBefore = await getNabuflowSubscription(COMET);
    const [cometCycle] = await db
      .select()
      .from(nabuflowBillingCyclesTable)
      .where(and(eq(nabuflowBillingCyclesTable.userId, COMET), eq(nabuflowBillingCyclesTable.cycleStart, cometBefore!.currentCycleStart!)));
    const expectedRollover = computeNabuflowRollover(
      NABUFLOW_PLANS.comet,
      cometCycle.includedCredits,
      cometCycle.usedIncludedCredits,
    );
    const cShiftStart = new Date(cometBefore!.currentCycleStart!.getTime() - 31 * DAY);
    const cShiftEnd = new Date(cometBefore!.currentCycleEnd!.getTime() - 31 * DAY);
    await db
      .update(nabuflowSubscriptionsTable)
      .set({ currentCycleStart: cShiftStart, currentCycleEnd: cShiftEnd })
      .where(eq(nabuflowSubscriptionsTable.userId, COMET));
    await db
      .update(nabuflowBillingCyclesTable)
      .set({ cycleStart: cShiftStart, cycleEnd: cShiftEnd })
      .where(eq(nabuflowBillingCyclesTable.id, cometCycle.id));

    const deepAgain = await resolveNabuflowBuildGate(COMET, { engineMode: "power", deepReasoning: true, projectedCredits: 15 });
    check("Comet Deep allowed again after rollover", deepAgain.allowed === true, deepAgain);
    const sC = await api(COMET, "GET", "/billing/nabuflow/state");
    check("Comet Deep counter reset (0/10)", sC.json?.cycle?.deepBuildsUsed === 0 && sC.json?.cycle?.remainingDeepBuilds === 10, sC.json?.cycle);
    check(
      "Comet unused credits rolled one cycle (capped)",
      sC.json?.cycle?.includedCredits === NABUFLOW_PLANS.comet.includedMonthlyCredits + expectedRollover,
      { actual: sC.json?.cycle?.includedCredits, expectedRollover },
    );
    const cometAfter = await getNabuflowSubscription(COMET);
    check("rollover persisted on subscription", cometAfter!.rolloverCredits === expectedRollover, cometAfter!.rolloverCredits);
  }

  // ── F. Overage → Stripe invoice item + spend cap + reconciliation ─────────
  console.log("\nF. Overage invoice items, spend cap, usage reconciliation");
  {
    // Give Orbit a REAL Stripe customer so overage reporting hits test mode.
    const cust = await stripe.customers.create({
      name: `E2E Ladder Orbit ${ts}`,
      email: `ladder+${ts}@e2e.test`,
      metadata: { surface: "nabuflow", e2e: "ladder" },
    });
    await db
      .update(nabuflowSubscriptionsTable)
      .set({ stripeCustomerId: cust.id })
      .where(eq(nabuflowSubscriptionsTable.userId, ORBIT));

    // Exhaust the included bucket so the next charge is pure overage.
    const orbitSub = await getNabuflowSubscription(ORBIT);
    await db
      .update(nabuflowBillingCyclesTable)
      .set({ usedIncludedCredits: NABUFLOW_PLANS.orbit.includedMonthlyCredits })
      .where(and(eq(nabuflowBillingCyclesTable.userId, ORBIT), eq(nabuflowBillingCyclesTable.cycleStart, orbitSub!.currentCycleStart!)));

    const charge = await maybeChargeNabuflow(ORBIT, 100, { type: "build", description: "E2E overage build", engineMode: "power" });
    check("overage charge accepted (never blocks in-flight)", charge !== null && charge!.newBalance === 0, charge);

    const [ovEvent] = await db
      .select()
      .from(nabuflowUsageEventsTable)
      .where(and(eq(nabuflowUsageEventsTable.userId, ORBIT), eq(nabuflowUsageEventsTable.attribution, "overage")));
    check("overage event: 100cr @ $0.012 = 120¢", ovEvent?.overageCredits === 100 && ovEvent?.overageUsdCents === 120, ovEvent);

    // Async invoice-item reporting lands on the customer in Stripe test mode.
    let itemId: string | null = null;
    for (let i = 0; i < 20 && !itemId; i++) {
      const [row] = await db
        .select()
        .from(nabuflowUsageEventsTable)
        .where(eq(nabuflowUsageEventsTable.id, ovEvent.id));
      itemId = row.stripeInvoiceItemId;
      if (!itemId) await sleep(500);
    }
    check("overage reported to Stripe (invoice item id saved)", !!itemId, itemId);
    if (itemId) {
      const item = (await stripe.invoiceItems.retrieve(itemId)) as any;
      check("invoice item bills the right customer", (typeof item.customer === "string" ? item.customer : item.customer?.id) === cust.id);
      check("invoice item amount = ledger cents", item.amount === 120, item.amount);
      check(
        "invoice item line is human-readable",
        typeof item.description === "string" && /pay-as-you-go|overage/i.test(item.description) && /100 credits/.test(item.description),
        item.description,
      );
    }

    // Spend cap: projected overage past the cap blocks pre-start only.
    const capBlock = await resolveNabuflowBuildGate(ORBIT, { engineMode: "eco", projectedCredits: 2100 });
    check("projected overage past cap → spend_cap_reached", !capBlock.allowed && gateErr(capBlock)?.code === "spend_cap_reached", capBlock);
    const capDrain = await resolveNabuflowBuildGate(ORBIT, { engineMode: "eco", projectedCredits: 2100, skipUsageChecks: true });
    check("cap never kills in-flight builds", capDrain.allowed === true);
    const smallOk = await resolveNabuflowBuildGate(ORBIT, { engineMode: "eco", projectedCredits: 100 });
    check("small build under cap still allowed", smallOk.allowed === true, smallOk);

    // Usage dashboard reconciliation: API events == cycle counters == ledger.
    const [cycleNow] = await db
      .select()
      .from(nabuflowBillingCyclesTable)
      .where(and(eq(nabuflowBillingCyclesTable.userId, ORBIT), eq(nabuflowBillingCyclesTable.cycleStart, orbitSub!.currentCycleStart!)));
    const liveEvents = await db
      .select()
      .from(nabuflowUsageEventsTable)
      .where(and(eq(nabuflowUsageEventsTable.userId, ORBIT), eq(nabuflowUsageEventsTable.cycleId, cycleNow.id), isNull(nabuflowUsageEventsTable.reversedAt)));
    const evCredits = liveEvents.reduce((s, e) => s + e.credits, 0);
    const evOverageCents = liveEvents.reduce((s, e) => s + e.overageUsdCents, 0);
    const cycleUsed = cycleNow.usedIncludedCredits - NABUFLOW_PLANS.orbit.includedMonthlyCredits + cycleNow.overageCredits; // seeded exhaustion offset
    check("event credits reconcile with cycle counters", evCredits === cycleUsed, { evCredits, cycleUsed });
    check("event overage cents reconcile with cycle", evOverageCents === cycleNow.overageUsdCents, { evOverageCents, cycle: cycleNow.overageUsdCents });
    const proEvents = liveEvents.filter((e) => e.engineMode === "pro" && (e.source === "pipeline" || e.source === "background" || e.source === "queue"));
    check("pro-build events == proBuildsUsed", proEvents.length === cycleNow.proBuildsUsed, { n: proEvents.length, c: cycleNow.proBuildsUsed });

    const usage = await api(ORBIT, "GET", "/billing/nabuflow/usage");
    const blob = JSON.stringify(usage.json ?? {});
    check("usage dashboard shows the overage event", usage.status === 200 && blob.includes("overage"), usage.status);
  }

  // ── G. Ora independence (personal lane) ────────────────────────────────────
  console.log("\nG. Ora independence");
  {
    const ora = await api(ORBIT, "GET", "/credits");
    check("Ora credits API unaffected for ladder users", ora.status === 200 && ora.json !== null, ora.status);
  }

  console.log(`\n═══ Result: ${pass} passed, ${fail} failed ═══`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
