import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { db, oraConversationsTable } from "@workspace/db";
import oraConversationsRouter from "../ora-conversations";

// The help router (which owns the support list endpoint) resolves auth itself
// and pulls in several heavy modules. We mock only those side-effecting deps —
// the database stays REAL so the surface filter is genuinely exercised.
vi.mock("../../lib/public-ai/authed-user", () => ({
  resolveAuthedOraUser: vi.fn(),
}));
vi.mock("../../lib/public-ai/prompt", () => ({
  ORA_SUPPORT_SYSTEM_PROMPT: "SUPPORT_SYSTEM_PROMPT",
  scanUserInput: vi.fn(() => true),
}));
vi.mock("../../lib/ora-assets", () => ({
  persistOraAsset: vi.fn(async () => 1),
}));
vi.mock("../../lib/emailClient", () => ({
  sendEmailWithStatus: vi.fn(async () => "sent"),
}));
vi.mock("../../lib/emailTemplates", () => ({
  supportTicketTemplate: vi.fn(() => ({ subject: "s", html: "h", text: "t" })),
}));
vi.mock("../../lib/clerk-users", () => ({
  getClerkUserById: vi.fn(async () => ({ userId: "user_1", email: "user@example.com" })),
}));
vi.mock("../../lib/ai-providers", () => ({
  createChatCompletion: vi.fn(async () => ({ choices: [{ message: { content: "ok" } }] })),
}));

import { resolveAuthedOraUser } from "../../lib/public-ai/authed-user";

/**
 * Regression tests: Support Mode chats stay private from normal Ora (Task #1314).
 *
 * Support Mode conversations live on a separate `surface='support'` partition.
 * Every single-row endpoint on `/ora/conversations/:id` (GET / PATCH /
 * PUT-messages / DELETE) MUST filter `surface='normal'`, so a support
 * conversation id is never readable or mutable through the normal Ora routes.
 * The list endpoints must likewise stay partitioned: the normal list excludes
 * support rows and the support list excludes normal rows.
 *
 * A future refactor could silently drop the surface filter and re-open the
 * cross-surface bypass — these tests guard against that.
 */

const USER = `test-ora-surface-${Date.now()}`;

let normalId: number;
let supportId: number;

function appAs(userId: string) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.userId = userId;
    next();
  });
  app.use(oraConversationsRouter);
  return app;
}

beforeAll(async () => {
  // A normal Ora conversation (default surface).
  const [normal] = await db
    .insert(oraConversationsTable)
    .values({ userId: USER, title: "Normal chat", messages: [], surface: "normal" })
    .returning({ id: oraConversationsTable.id });
  normalId = normal!.id;

  // A Support Mode conversation on the isolated "support" surface.
  const [support] = await db
    .insert(oraConversationsTable)
    .values({
      userId: USER,
      title: "Support chat",
      messages: [{ role: "user", content: "I was charged twice" }],
      surface: "support",
    })
    .returning({ id: oraConversationsTable.id });
  supportId = support!.id;
});

afterAll(async () => {
  await db.delete(oraConversationsTable).where(eq(oraConversationsTable.userId, USER));
});

describe("Support conversations are invisible to the normal /ora/conversations single-row endpoints", () => {
  it("GET /ora/conversations/:id returns 404 for a support-surface conversation", async () => {
    const app = appAs(USER);
    const res = await request(app).get(`/ora/conversations/${supportId}`);
    expect(res.status).toBe(404);
    expect(res.body.conversation).toBeUndefined();
  });

  it("GET /ora/conversations/:id still returns the user's own normal conversation", async () => {
    const app = appAs(USER);
    const res = await request(app).get(`/ora/conversations/${normalId}`);
    expect(res.status).toBe(200);
    expect(res.body.conversation.id).toBe(normalId);
  });

  it("PATCH /ora/conversations/:id returns 404 for a support-surface conversation", async () => {
    const app = appAs(USER);
    const res = await request(app)
      .patch(`/ora/conversations/${supportId}`)
      .send({ title: "hijacked" });
    expect(res.status).toBe(404);

    // The support row must remain untouched in the DB.
    const [row] = await db
      .select({ title: oraConversationsTable.title })
      .from(oraConversationsTable)
      .where(eq(oraConversationsTable.id, supportId));
    expect(row?.title).toBe("Support chat");
  });

  it("PUT /ora/conversations/:id/messages returns 404 for a support-surface conversation", async () => {
    const app = appAs(USER);
    const res = await request(app)
      .put(`/ora/conversations/${supportId}/messages`)
      .send({ messages: [{ role: "user", content: "leaked" }] });
    expect(res.status).toBe(404);

    // The support transcript must remain untouched.
    const [row] = await db
      .select({ messages: oraConversationsTable.messages })
      .from(oraConversationsTable)
      .where(eq(oraConversationsTable.id, supportId));
    const messages = row?.messages as Array<{ content: string }>;
    expect(messages).toHaveLength(1);
    expect(messages[0]?.content).toBe("I was charged twice");
  });

  it("DELETE /ora/conversations/:id returns 404 and does not archive a support-surface conversation", async () => {
    const app = appAs(USER);
    const res = await request(app).delete(`/ora/conversations/${supportId}`);
    // The surface filter means no support row matched, so the endpoint 404s
    // instead of silently reporting success.
    expect(res.status).toBe(404);

    // Secondary guard: the support row must remain un-archived.
    const [row] = await db
      .select({ archivedAt: oraConversationsTable.archivedAt })
      .from(oraConversationsTable)
      .where(eq(oraConversationsTable.id, supportId));
    expect(row?.archivedAt).toBeNull();
  });
});

describe("List endpoints stay partitioned by surface", () => {
  it("GET /ora/conversations (normal list) excludes support rows", async () => {
    const app = appAs(USER);
    const res = await request(app).get("/ora/conversations");
    expect(res.status).toBe(200);
    const ids = (res.body.conversations as Array<{ id: number }>).map((c) => c.id);
    expect(ids).toContain(normalId);
    expect(ids).not.toContain(supportId);
  });

  it("GET /help/support/conversations (support list) excludes normal rows", async () => {
    vi.mocked(resolveAuthedOraUser).mockResolvedValue({
      userId: USER,
      tier: "free",
      isPaid: false,
    });
    const helpRouter = (await import("../help")).default;
    const app = express();
    app.use(express.json());
    app.use(helpRouter);

    const res = await request(app).get("/help/support/conversations");
    expect(res.status).toBe(200);
    const ids = (res.body.conversations as Array<{ id: number }>).map((c) => c.id);
    expect(ids).toContain(supportId);
    expect(ids).not.toContain(normalId);
  });
});
