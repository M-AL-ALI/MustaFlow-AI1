/**
 * Escalation email integration tests.
 *
 * Suite 1 — Template-fidelity (always runs, no live network call).
 *   Uses the real supportTicketTemplate (not mocked) and asserts that the
 *   payload sent to sendEmailWithStatus has the correct subject format,
 *   branding, ticket-id, user email, plan, and transcript body.
 *
 * Suite 2 — Live Resend delivery (skipped unless RESEND_API_KEY + SUPPORT_EMAIL
 *   are both present in process.env). Calls the real Resend HTTP client and
 *   asserts emailStatus === "sent". This is the end-to-end acceptance check.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import request from "supertest";

// ── DB mock (chainable, queue-based) ─────────────────────────────────────────

const dbResults: unknown[] = [];

function makeChain() {
  const chain: Record<string, unknown> = {};
  const passthrough = [
    "from", "where", "orderBy", "limit", "set", "returning",
    "onConflictDoNothing", "onConflictDoUpdate",
  ];
  for (const m of passthrough) chain[m] = vi.fn(() => chain);
  chain.select = vi.fn(() => chain);
  chain.insert = vi.fn(() => chain);
  chain.update = vi.fn(() => chain);
  chain.delete = vi.fn(() => chain);
  chain.values = vi.fn(() => chain);
  (chain as { then: unknown }).then = (
    resolve: (v: unknown) => unknown,
    reject: (e: unknown) => unknown,
  ) => {
    const next = dbResults.length ? dbResults.shift() : [];
    return Promise.resolve(next).then(resolve, reject);
  };
  return chain;
}

function tableProxy(name: string) {
  return new Proxy(
    { _name: name, $inferSelect: {} },
    { get: (t, p) => (p in t ? (t as Record<string, unknown>)[p as string] : { _col: p }) },
  );
}

vi.mock("@workspace/db", () => ({
  db: makeChain(),
  helpArticlesTable: tableProxy("help_articles"),
  supportTicketsTable: tableProxy("support_tickets"),
  oraConversationsTable: tableProxy("ora_conversations"),
  projectsTable: tableProxy("projects"),
}));

vi.mock("../../lib/public-ai/authed-user", () => ({
  resolveAuthedOraUser: vi.fn(),
}));

vi.mock("../../lib/public-ai/prompt", () => ({
  ORA_SUPPORT_SYSTEM_PROMPT: "SUPPORT",
  scanUserInput: vi.fn(() => true),
}));

vi.mock("../../lib/ora-assets", () => ({
  persistOraAsset: vi.fn(async () => 42),
}));

vi.mock("../../lib/clerk-users", () => ({
  getClerkUserById: vi.fn(async () => ({
    userId: "user_integ",
    email: "requester@example.com",
  })),
}));

vi.mock("../../lib/rateLimit", () => ({
  supportChatLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
  supportEscalateLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

vi.mock("../../lib/ai-providers", () => ({
  createChatCompletion: vi.fn(async () => ({
    choices: [{ message: { content: "Support reply" } }],
  })),
}));

vi.mock("../../lib/support-alerts", () => ({
  broadcastNewTicket: vi.fn(),
}));

// ── Capture calls + delegate to real Resend when key is present ───────────────
//
// NOTE: We do NOT mock emailTemplates here — the real supportTicketTemplate
// runs so we can assert on its actual output fields.

const capturedSendCalls: Array<{ to: string; subject: string; html: string; text: string }> = [];

const { sendEmailWithStatusImpl } = vi.hoisted(() => {
  // We need a stable reference for vi.mock factory; the real logic lives in the
  // named export below which we patch in the mock factory.
  return { sendEmailWithStatusImpl: { fn: null as unknown } };
});

vi.mock("../../lib/emailClient", () => ({
  sendEmailWithStatus: async (opts: {
    to: string;
    subject: string;
    html: string;
    text?: string;
  }) => {
    capturedSendCalls.push({
      to: opts.to,
      subject: opts.subject,
      html: opts.html,
      text: opts.text ?? "",
    });
    // Delegate to whatever fn is registered at call time
    if (typeof (sendEmailWithStatusImpl as { fn: unknown }).fn === "function") {
      return (sendEmailWithStatusImpl as { fn: (...a: unknown[]) => unknown }).fn(opts);
    }
    return "skipped";
  },
}));

import { resolveAuthedOraUser } from "../../lib/public-ai/authed-user";

async function buildApp() {
  const app = express();
  app.use(express.json({ limit: "20mb" }));
  const router = (await import("../help")).default;
  app.use(router);
  return app;
}

function seedInsert(ticketId: number) {
  dbResults.push([{ id: ticketId }]); // INSERT returning id
  dbResults.push([]);                 // UPDATE emailStatus
  dbResults.push([]);                 // broadcastNewTicket
}

const TRANSCRIPT = [
  { role: "user" as const, content: "My project won't deploy." },
  { role: "assistant" as const, content: "Let me check that for you." },
];

let app: Awaited<ReturnType<typeof buildApp>>;

// Stash originals so each suite can set its own env without polluting others
let origResendKey: string | undefined;
let origSupportEmail: string | undefined;

beforeEach(async () => {
  vi.clearAllMocks();
  dbResults.length = 0;
  capturedSendCalls.length = 0;
  origResendKey = process.env.RESEND_API_KEY;
  origSupportEmail = process.env.SUPPORT_EMAIL;
  // Default: no live sending
  (sendEmailWithStatusImpl as { fn: unknown }).fn = async () => "skipped";
  vi.mocked(resolveAuthedOraUser).mockResolvedValue({
    userId: "user_integ",
    tier: "core",
    isPaid: true,
  });
  app = await buildApp();
});

afterEach(() => {
  // Restore env exactly as it was before the test
  if (origResendKey === undefined) delete process.env.RESEND_API_KEY;
  else process.env.RESEND_API_KEY = origResendKey;
  if (origSupportEmail === undefined) delete process.env.SUPPORT_EMAIL;
  else process.env.SUPPORT_EMAIL = origSupportEmail;
});

// ─────────────────────────────────────────────────────────────────────────────
// Suite 1: template-fidelity (always runs, no live Resend network call)
// ─────────────────────────────────────────────────────────────────────────────

describe("Escalation → supportTicketTemplate fidelity (no live network)", () => {
  beforeEach(() => {
    delete process.env.RESEND_API_KEY;
    process.env.SUPPORT_EMAIL = "support@mustaflow.app";
  });

  it("passes real supportTicketTemplate subject to sendEmailWithStatus", async () => {
    seedInsert(77);

    const res = await request(app)
      .post("/help/support/escalate")
      .send({ subject: "Cannot publish my app", category: "publishing", transcript: TRANSCRIPT });

    expect(res.status).toBe(201);
    expect(capturedSendCalls).toHaveLength(1);
    const call = capturedSendCalls[0]!;
    expect(call.to).toBe("support@mustaflow.app");
    // Real template: "[Support #<id>] <subject>"
    expect(call.subject).toMatch(/^\[Support #\d+\] Cannot publish my app$/);
  });

  it("includes ticketId, user email, plan, and transcript in the real template payload", async () => {
    seedInsert(88);

    const res = await request(app)
      .post("/help/support/escalate")
      .send({ subject: "Credits missing", category: "billing", transcript: TRANSCRIPT });

    expect(res.status).toBe(201);
    expect(capturedSendCalls).toHaveLength(1);
    const { html, text, subject } = capturedSendCalls[0]!;

    // Subject contains ticket number
    expect(subject).toMatch(/\[Support #\d+\]/);

    // HTML contains MustaFlow branding from wrap()
    expect(html).toContain("MustaFlow");

    // HTML contains the requester's email (from Clerk mock)
    expect(html).toContain("requester@example.com");

    // HTML contains the plan
    expect(html).toContain("core");

    // Transcript content — apostrophe is NOT HTML-escaped by this template's esc()
    // which only escapes &, <, > — so the raw string appears as-is
    expect(html).toContain("won");
    expect(html).toContain("deploy");

    // Text version is populated
    expect(text).toContain("Credits missing");
    expect(text).toContain("requester@example.com");
  });

  it("records emailStatus on ticket even when RESEND_API_KEY is absent (skipped)", async () => {
    seedInsert(99);

    const res = await request(app)
      .post("/help/support/escalate")
      .send({ subject: "No-key test", transcript: TRANSCRIPT });

    expect(res.status).toBe(201);
    // sendEmailWithStatus was still called (template evaluated), returned skipped
    expect(capturedSendCalls).toHaveLength(1);
    expect(res.body.emailStatus).toBe("skipped");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Suite 2: live Resend delivery (skipped when env vars absent)
// ─────────────────────────────────────────────────────────────────────────────

const LIVE_ENABLED =
  Boolean(process.env.RESEND_API_KEY) && Boolean(process.env.SUPPORT_EMAIL);

describe.skipIf(!LIVE_ENABLED)(
  "Escalation → live Resend delivery (RESEND_API_KEY + SUPPORT_EMAIL set)",
  () => {
    beforeEach(() => {
      // Ensure env vars are set (they're already in process.env from secrets;
      // the global beforeEach stashed originals and afterEach will restore them)
      // Wire the real Resend client for live calls
      (sendEmailWithStatusImpl as { fn: unknown }).fn = async (opts: {
        to: string;
        subject: string;
        html: string;
        text?: string;
      }) => {
        const apiKey = process.env.RESEND_API_KEY;
        if (!apiKey) return "skipped";
        const { Resend } = await import("resend");
        const client = new Resend(apiKey);
        const from = process.env.SMTP_FROM ?? "noreply@mustaflow.app";
        const { error } = await client.emails.send({
          from,
          to: opts.to,
          subject: opts.subject,
          html: opts.html,
          text: opts.text,
        });
        return error ? "failed" : "sent";
      };
    });

    it(
      "delivers escalation email end-to-end and emailStatus is sent",
      async () => {
        seedInsert(1);

        const res = await request(app)
          .post("/help/support/escalate")
          .send({
            subject: "[Integration test] Escalation delivery check",
            category: "general",
            transcript: [
              {
                role: "user" as const,
                content: "Automated integration test — please ignore.",
              },
              {
                role: "assistant" as const,
                content: "Received. Escalation email path is confirmed working.",
              },
            ],
          });

        // Ticket must persist regardless of email outcome
        expect(res.status).toBe(201);
        expect(typeof res.body.ticketId).toBe("number");

        // Core acceptance criterion: Resend accepted the email
        expect(res.body.emailStatus).toBe("sent");

        // Sent to the correct SUPPORT_EMAIL inbox
        expect(capturedSendCalls).toHaveLength(1);
        expect(capturedSendCalls[0]!.to).toBe(process.env.SUPPORT_EMAIL);
        expect(capturedSendCalls[0]!.subject).toMatch(
          /^\[Support #\d+\] \[Integration test\] Escalation delivery check$/,
        );
      },
      30_000,
    );
  },
);
