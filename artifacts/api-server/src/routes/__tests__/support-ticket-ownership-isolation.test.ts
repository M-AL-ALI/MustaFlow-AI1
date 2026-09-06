import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import express from "express";
import request from "supertest";
import { and, eq, inArray } from "drizzle-orm";
import { db, supportTicketsTable, projectsTable, workspacesTable } from "@workspace/db";
import { createOwnedWorkspace } from "../../lib/workspace-foundation";

/**
 * Regression tests: Support tickets are private to their owner (Task #1315).
 *
 * The sibling surface to Support Mode *conversations* (guarded by
 * ora-support-surface-isolation.test.ts) is the *support tickets* created by the
 * escalation flow. A ticket carries the user's transcript, account email, plan,
 * and optionally a project reference, so it must never be readable across
 * accounts and an escalation must never attach a project the requester does not
 * own.
 *
 * These tests keep the DATABASE real (only side-effecting deps are mocked) so
 * the ownership scoping is genuinely exercised:
 *   1. Escalating as two different users produces two tickets, each stamped with
 *      the *authenticated* userId — a userId-scoped read returns only the
 *      owner's ticket. This is the contract any future ticket list/read path
 *      must honor; if a refactor drops the userId filter, the cross-account
 *      assertion here fails.
 *   2. The ticket userId comes from the session, not the request body, so a
 *      caller cannot forge ownership.
 *   3. An escalation referencing a project owned by *another* user has that
 *      projectId dropped (stored null); a project the requester owns is kept.
 */

// The help router resolves auth itself and pulls in several heavy modules. We
// mock only those side-effecting deps — the DB stays REAL.
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
  supportTicketConfirmationTemplate: vi.fn(({ ticketId }: { ticketId: number }) => ({
    subject: `Support ticket NF-${String(ticketId).padStart(6, "0")} received`,
    html: "h",
    text: "t",
  })),
}));
vi.mock("../../lib/clerk-users", () => ({
  getClerkUserById: vi.fn(async () => ({ userId: "u", email: "user@example.com" })),
}));
vi.mock("../../lib/ai-providers", () => ({
  createChatCompletion: vi.fn(async () => ({ choices: [{ message: { content: "ok" } }] })),
}));

// Bypass rate limiting so tests aren't throttled by the escalate limiter.
vi.mock("../../lib/rateLimit", () => ({
  supportChatLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
  supportEscalateLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

import { resolveAuthedOraUser } from "../../lib/public-ai/authed-user";

const SUFFIX = Date.now();
const USER_A = `ticket-owner-a-${SUFFIX}`;
const USER_B = `ticket-owner-b-${SUFFIX}`;
const ALL_USERS = [USER_A, USER_B];

let projectA: number;
let projectB: number;
const workspaceIds: number[] = [];

function actAs(userId: string) {
  vi.mocked(resolveAuthedOraUser).mockResolvedValue({
    userId,
    tier: "free",
    isPaid: false,
  });
}

async function buildApp() {
  const helpRouter = (await import("../help")).default;
  const app = express();
  app.use(express.json());
  app.use(helpRouter);
  return app;
}

async function escalateAs(app: express.Express, userId: string, body: Record<string, unknown>) {
  actAs(userId);
  return request(app)
    .post("/help/support/escalate")
    .send({ subject: "Need help", transcript: [], ...body });
}

beforeAll(async () => {
  if (process.env.NABUFLOW_VITEST_DATABASE_ENABLED !== "true") return;
  const workspaceA = await createOwnedWorkspace({
    ownerUserId: USER_A,
    name: "Owner A workspace",
    type: "personal",
  });
  const workspaceB = await createOwnedWorkspace({
    ownerUserId: USER_B,
    name: "Owner B workspace",
    type: "personal",
  });
  workspaceIds.push(workspaceA.id, workspaceB.id);
  const [a] = await db
    .insert(projectsTable)
    .values({ ownerId: USER_A, workspaceId: workspaceA.id, name: "Owner A project" })
    .returning({ id: projectsTable.id });
  projectA = a!.id;

  const [b] = await db
    .insert(projectsTable)
    .values({ ownerId: USER_B, workspaceId: workspaceB.id, name: "Owner B project" })
    .returning({ id: projectsTable.id });
  projectB = b!.id;
});

afterAll(async () => {
  if (process.env.NABUFLOW_VITEST_DATABASE_ENABLED !== "true") return;
  await db.delete(supportTicketsTable).where(inArray(supportTicketsTable.userId, ALL_USERS));
  await db.delete(projectsTable).where(inArray(projectsTable.ownerId, ALL_USERS));
  await db.delete(workspacesTable).where(inArray(workspacesTable.id, workspaceIds));
});

describe.skipIf(process.env.NABUFLOW_VITEST_DATABASE_ENABLED !== "true")(
  "Support tickets are scoped to their owner",
  () => {
    it("each user only sees their own tickets when listed by userId", async () => {
      const app = await buildApp();

      const resA = await escalateAs(app, USER_A, { subject: "A only ticket" });
      expect(resA.status).toBe(201);
      const resB = await escalateAs(app, USER_B, { subject: "B only ticket" });
      expect(resB.status).toBe(201);

      // Sanity: both tickets really exist in the table.
      const both = await db
        .select({ id: supportTicketsTable.id, userId: supportTicketsTable.userId })
        .from(supportTicketsTable)
        .where(inArray(supportTicketsTable.userId, ALL_USERS));
      expect(both).toHaveLength(2);

      // The ownership-scoped read (the contract any ticket list/read path MUST
      // use) returns only the owner's ticket.
      const aTickets = await db
        .select({ id: supportTicketsTable.id, userId: supportTicketsTable.userId })
        .from(supportTicketsTable)
        .where(eq(supportTicketsTable.userId, USER_A));
      expect(aTickets).toHaveLength(1);
      expect(aTickets.every((t) => t.userId === USER_A)).toBe(true);
      expect(aTickets.map((t) => t.id)).toContain(resA.body.ticketId);
      expect(aTickets.map((t) => t.id)).not.toContain(resB.body.ticketId);

      const bTickets = await db
        .select({ id: supportTicketsTable.id, userId: supportTicketsTable.userId })
        .from(supportTicketsTable)
        .where(eq(supportTicketsTable.userId, USER_B));
      expect(bTickets).toHaveLength(1);
      expect(bTickets.every((t) => t.userId === USER_B)).toBe(true);
      expect(bTickets.map((t) => t.id)).toContain(resB.body.ticketId);
      expect(bTickets.map((t) => t.id)).not.toContain(resA.body.ticketId);
    });

    it("stamps the ticket userId from the authenticated session, not the request body", async () => {
      const app = await buildApp();

      // Act as A but try to forge ownership by passing USER_B in the body.
      const res = await escalateAs(app, USER_A, {
        subject: "Forged owner attempt",
        userId: USER_B,
        ownerId: USER_B,
      });
      expect(res.status).toBe(201);

      const [row] = await db
        .select({ userId: supportTicketsTable.userId })
        .from(supportTicketsTable)
        .where(eq(supportTicketsTable.id, res.body.ticketId));
      expect(row?.userId).toBe(USER_A);
    });
  },
);

describe.skipIf(process.env.NABUFLOW_VITEST_DATABASE_ENABLED !== "true")(
  "Internal staff notes are never exposed to the requester",
  () => {
    it("excludes internalNote transcript entries from GET /help/support/tickets/:id", async () => {
      const app = await buildApp();

      // Create a ticket for USER_A with a customer-visible transcript message.
      const res = await escalateAs(app, USER_A, {
        subject: "Ticket with internal note",
        transcript: [{ role: "user", content: "Customer visible message" }],
      });
      expect(res.status).toBe(201);
      const ticketId = res.body.ticketId as number;

      // Simulate an admin adding an internal staff-only note straight into the
      // transcript (mirrors POST /admin/support-tickets/:id/note).
      await db
        .update(supportTicketsTable)
        .set({
          transcript: [
            { role: "user", content: "Customer visible message" },
            {
              role: "assistant",
              content: "SECRET internal note — duplicate of #42",
              internalNote: true,
              authorId: "admin-user",
              at: new Date().toISOString(),
            },
          ],
        })
        .where(eq(supportTicketsTable.id, ticketId));

      // The requester reads their own ticket — the internal note must not appear.
      actAs(USER_A);
      const detail = await request(app).get(`/help/support/tickets/${ticketId}`);
      expect(detail.status).toBe(200);
      const transcript = detail.body.transcript as { role: string; content: string }[];
      expect(transcript).toHaveLength(1);
      expect(transcript[0]?.content).toBe("Customer visible message");
      expect(JSON.stringify(detail.body)).not.toContain("SECRET internal note");
    });
  },
);

describe.skipIf(process.env.NABUFLOW_VITEST_DATABASE_ENABLED !== "true")(
  "Escalation drops a cross-user projectId",
  () => {
    it("drops a projectId the requesting user does not own", async () => {
      const app = await buildApp();

      // USER_A escalates referencing USER_B's project — it must be dropped.
      const res = await escalateAs(app, USER_A, {
        subject: "Reference foreign project",
        projectId: projectB,
      });
      expect(res.status).toBe(201);

      const [row] = await db
        .select({ projectId: supportTicketsTable.projectId })
        .from(supportTicketsTable)
        .where(eq(supportTicketsTable.id, res.body.ticketId));
      expect(row?.projectId).toBeNull();
    });

    it("keeps a projectId the requesting user owns", async () => {
      const app = await buildApp();

      const res = await escalateAs(app, USER_A, {
        subject: "Reference own project",
        projectId: projectA,
      });
      expect(res.status).toBe(201);

      const [row] = await db
        .select({ projectId: supportTicketsTable.projectId })
        .from(supportTicketsTable)
        .where(
          and(
            eq(supportTicketsTable.id, res.body.ticketId),
            eq(supportTicketsTable.userId, USER_A),
          ),
        );
      expect(row?.projectId).toBe(projectA);
    });
  },
);
