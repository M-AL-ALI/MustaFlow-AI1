/**
 * Auto-reply confirmation email tests for POST /help/support/escalate.
 *
 * Covers:
 *  1. When the submitter has an email address, a confirmation email is sent to
 *     them immediately after the ticket is created (second sendEmailWithStatus call).
 *  2. When the submitter's email is null, the auto-reply is silently skipped —
 *     no second sendEmailWithStatus call, no error, ticket still succeeds.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import express from "express";
import request from "supertest";

// ── Chainable Drizzle-like mock ───────────────────────────────────────────────

const dbResults: unknown[] = [];

function makeChain() {
  let pendingInsertTable: unknown = null;
  const chain: Record<string, unknown> = {};
  const passthrough = [
    "from",
    "where",
    "orderBy",
    "limit",
    "set",
    "returning",
    "onConflictDoNothing",
    "onConflictDoUpdate",
  ];
  for (const m of passthrough) chain[m] = vi.fn(() => chain);
  chain.select = vi.fn(() => chain);
  chain.insert = vi.fn((table: unknown) => {
    pendingInsertTable = table;
    return chain;
  });
  chain.update = vi.fn(() => chain);
  chain.delete = vi.fn(() => chain);
  chain.values = vi.fn((_values: unknown) => {
    void pendingInsertTable; // consumed
    return chain;
  });
  (chain as { then: unknown }).then = (
    resolve: (v: unknown) => unknown,
    _reject: (e: unknown) => unknown,
  ) => {
    const next = dbResults.length ? dbResults.shift() : [];
    return Promise.resolve(next).then(resolve);
  };
  return chain;
}

const dbMock = makeChain();

function tableProxy(name: string) {
  return new Proxy(
    { _name: name, $inferSelect: {} },
    {
      get: (t, p) => (p in t ? (t as Record<string, unknown>)[p as string] : { _col: p }),
    },
  );
}

vi.mock("@workspace/db", () => ({
  db: dbMock,
  helpArticlesTable: tableProxy("help_articles"),
  supportTicketsTable: tableProxy("support_tickets"),
  oraConversationsTable: tableProxy("ora_conversations"),
  projectsTable: tableProxy("projects"),
}));

vi.mock("../../lib/public-ai/authed-user", () => ({
  resolveAuthedOraUser: vi.fn(),
}));

vi.mock("../../lib/public-ai/prompt", () => ({
  ORA_SUPPORT_SYSTEM_PROMPT: "SUPPORT_SYSTEM_PROMPT",
  scanUserInput: vi.fn(() => true),
}));

vi.mock("../../lib/ora-assets", () => ({
  persistOraAsset: vi.fn(async () => 9999),
}));

const { sendEmailWithStatusMock } = vi.hoisted(() => ({
  sendEmailWithStatusMock: vi.fn(async () => "sent" as "sent" | "skipped" | "failed"),
}));
vi.mock("../../lib/emailClient", () => ({
  sendEmailWithStatus: sendEmailWithStatusMock,
}));

vi.mock("../../lib/emailTemplates", () => ({
  supportTicketTemplate: vi.fn(() => ({
    subject: "New support ticket: test issue",
    html: "<p>ticket</p>",
    text: "ticket",
  })),
  supportTicketConfirmationTemplate: vi.fn((opts: { ticketId: number; subject: string }) => ({
    subject: `Support ticket #${opts.ticketId} received`,
    html: `<p>Ticket #${opts.ticketId} confirmed</p>`,
    text: `Ticket #${opts.ticketId} confirmed`,
  })),
}));

vi.mock("../../lib/clerk-users", () => ({
  getClerkUserById: vi.fn(async () => ({ userId: "user_ar", email: "submitter@example.com" })),
}));

vi.mock("../../lib/rateLimit", () => ({
  supportChatLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
  supportEscalateLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

vi.mock("../../lib/ai-providers", () => ({
  createChatCompletion: vi.fn(async () => ({
    choices: [{ message: { content: "Ora reply" } }],
  })),
}));

import { resolveAuthedOraUser } from "../../lib/public-ai/authed-user";
import { getClerkUserById } from "../../lib/clerk-users";
import { sendEmailWithStatus } from "../../lib/emailClient";

// ── Helpers ───────────────────────────────────────────────────────────────────

async function buildApp() {
  const app = express();
  app.use(express.json({ limit: "20mb" }));
  const router = (await import("../help")).default;
  app.use(router);
  return app;
}

function authedUser() {
  vi.mocked(resolveAuthedOraUser).mockResolvedValue({
    userId: "user_ar",
    tier: "free",
    isPaid: false,
  });
}

const TRANSCRIPT = [
  { role: "user" as const, content: "I can't log in." },
  { role: "assistant" as const, content: "Let me help you with that." },
];

let app: Awaited<ReturnType<typeof buildApp>>;

beforeEach(async () => {
  vi.clearAllMocks();
  dbResults.length = 0;
  sendEmailWithStatusMock.mockResolvedValue("sent");
  delete process.env.SUPPORT_EMAIL;
  app = await buildApp();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("POST /help/support/escalate — auto-reply confirmation", () => {
  it("sends a confirmation email to the submitter after the team notification", async () => {
    process.env.SUPPORT_EMAIL = "team@example.com";
    authedUser();
    // The Clerk mock already returns email: "submitter@example.com"
    dbResults.push([{ id: 42 }]); // INSERT ticket → id 42

    const res = await request(app)
      .post("/help/support/escalate")
      .send({ subject: "Login problem", transcript: TRANSCRIPT });

    expect(res.status).toBe(201);
    expect(res.body.ticketId).toBe(42);

    // Both team email AND auto-reply must have been attempted.
    const calls = vi.mocked(sendEmailWithStatus).mock.calls;
    expect(calls.length).toBe(2);

    // First call — team notification.
    expect(calls[0]?.[0].to).toBe("team@example.com");

    // Second call — submitter confirmation.
    const confirmCall = calls[1]?.[0];
    expect(confirmCall).toBeDefined();
    expect(confirmCall?.to).toBe("submitter@example.com");
    expect(confirmCall?.subject).toContain("#42");

    // Response surfaces both statuses.
    expect(res.body.emailStatus).toBe("sent");
    expect(res.body.autoReplyStatus).toBe("sent");
  });

  it("skips auto-reply gracefully when the submitter email is null, ticket still succeeds", async () => {
    process.env.SUPPORT_EMAIL = "team@example.com";
    authedUser();
    // Override Clerk mock to return no email for this test.
    vi.mocked(getClerkUserById).mockResolvedValue(null);
    dbResults.push([{ id: 43 }]); // INSERT ticket

    const res = await request(app)
      .post("/help/support/escalate")
      .send({ subject: "No email user", transcript: TRANSCRIPT });

    expect(res.status).toBe(201);
    expect(res.body.ticketId).toBe(43);

    // Only the team notification — no auto-reply call.
    const calls = vi.mocked(sendEmailWithStatus).mock.calls;
    expect(calls.length).toBe(1);
    expect(calls[0]?.[0].to).toBe("team@example.com");

    // Auto-reply status is skipped, not an error.
    expect(res.body.autoReplyStatus).toBe("skipped");
  });
});
