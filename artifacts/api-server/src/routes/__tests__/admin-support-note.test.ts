import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import express from "express";
import request from "supertest";
import { eq, inArray } from "drizzle-orm";

/**
 * Route-level tests for POST /api/admin/support-tickets/:id/note (Task #1316).
 *
 * Internal staff notes are a privacy-sensitive surface: they must be admin-gated,
 * persisted with `internalNote: true`, and must NEVER trigger an email to the
 * requester (unlike /reply). These tests keep the DATABASE real and mock only the
 * side-effecting email/storage deps so the admin gating and persistence are
 * genuinely exercised.
 */

const SUFFIX = Date.now();
const ADMIN_USER = `admin-note-${SUFFIX}`;
const NON_ADMIN_USER = `nonadmin-note-${SUFFIX}`;
const TICKET_OWNER = `ticket-owner-note-${SUFFIX}`;

// Side-effecting deps are mocked; if a note ever tried to send an email this spy
// would catch it.
const sendEmailSpy = vi.fn(async () => "sent");
vi.mock("../../lib/emailClient", () => ({
  sendEmailWithStatus: sendEmailSpy,
}));
vi.mock("../../lib/emailTemplates", () => ({
  supportReplyTemplate: vi.fn(() => ({ subject: "s", html: "h", text: "t" })),
}));
vi.mock("../../lib/cloudflare", () => ({
  r2GetObject: vi.fn(async () => null),
}));

import { adminAccessReceiptsTable, db, supportTicketsTable, userRolesTable } from "@workspace/db";

let ticketId: number;

// Build an app that acts as the given userId (sets req.userId before the router's
// requireAdmin runs).
function buildAppAs(userId: string | null) {
  return (async () => {
    const adminSupportRouter = (await import("../admin-support")).default;
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      if (userId) req.userId = userId;
      next();
    });
    app.use("/api", adminSupportRouter);
    return app;
  })();
}

beforeAll(async () => {
  if (process.env.NABUFLOW_VITEST_DATABASE_ENABLED !== "true") return;
  await db.insert(userRolesTable).values({
    userId: ADMIN_USER,
    role: "support",
    grantedBy: "admin-support-note-test",
  });
  const [row] = await db
    .insert(supportTicketsTable)
    .values({
      userId: TICKET_OWNER,
      subject: "Note target ticket",
      transcript: [{ role: "user", content: "Customer visible message" }],
    })
    .returning({ id: supportTicketsTable.id });
  ticketId = row!.id;
});

afterAll(async () => {
  if (process.env.NABUFLOW_VITEST_DATABASE_ENABLED !== "true") return;
  await db.delete(supportTicketsTable).where(inArray(supportTicketsTable.userId, [TICKET_OWNER]));
  await db
    .delete(adminAccessReceiptsTable)
    .where(
      inArray(adminAccessReceiptsTable.actorUserId, [ADMIN_USER, NON_ADMIN_USER, TICKET_OWNER]),
    );
  await db.delete(userRolesTable).where(eq(userRolesTable.userId, ADMIN_USER));
});

describe.skipIf(process.env.NABUFLOW_VITEST_DATABASE_ENABLED !== "true")(
  "POST /api/admin/support-tickets/:id/note",
  () => {
    it("makes the console indistinguishable from an unknown route to an unauthenticated caller", async () => {
      const app = await buildAppAs(null);
      const res = await request(app)
        .post(`/api/admin/support-tickets/${ticketId}/note`)
        .send({ note: "secret" });
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: "Not found" });
    });

    it("makes the console indistinguishable from an unknown route to nonstaff", async () => {
      const app = await buildAppAs(NON_ADMIN_USER);
      const res = await request(app)
        .post(`/api/admin/support-tickets/${ticketId}/note`)
        .send({ note: "secret" });
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: "Not found" });
    });

    it("rejects an empty note with 400", async () => {
      const app = await buildAppAs(ADMIN_USER);
      const res = await request(app)
        .post(`/api/admin/support-tickets/${ticketId}/note`)
        .send({ note: "   " });
      expect(res.status).toBe(400);
    });

    it("returns 404 for a missing ticket", async () => {
      const app = await buildAppAs(ADMIN_USER);
      const res = await request(app)
        .post(`/api/admin/support-tickets/99999999/note`)
        .send({ note: "hello" });
      expect(res.status).toBe(404);
    });

    it("persists an internal note and never sends an email", async () => {
      sendEmailSpy.mockClear();
      const app = await buildAppAs(ADMIN_USER);
      const res = await request(app)
        .post(`/api/admin/support-tickets/${ticketId}/note`)
        .send({ note: "waiting on engineering" });

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.message.internalNote).toBe(true);
      expect(res.body.message.authorId).toBe(ADMIN_USER);
      expect(res.body.message.content).toBe("waiting on engineering");

      // Adding a note must NOT email the requester.
      expect(sendEmailSpy).not.toHaveBeenCalled();

      // Persisted in the transcript with the internalNote flag.
      const [row] = await db
        .select({ transcript: supportTicketsTable.transcript })
        .from(supportTicketsTable)
        .where(eq(supportTicketsTable.id, ticketId));
      const transcript = row!.transcript as { content: string; internalNote?: boolean }[];
      const note = transcript.find((m) => m.internalNote === true);
      expect(note?.content).toBe("waiting on engineering");
    });
  },
);
