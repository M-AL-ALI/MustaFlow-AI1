import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  process.env.DATABASE_URL = "postgresql://test:test@127.0.0.1:1/test";
  return {
    selectResults: [] as unknown[][],
    updateResults: [] as unknown[][],
    insertResults: [] as unknown[][],
    select: vi.fn(),
    update: vi.fn(),
    insert: vi.fn(),
    recordSupportGrantEvent: vi.fn(),
    deliverSupportConsequence: vi.fn(),
    withActiveProjectLifecycle: vi.fn(),
  };
});

function selectQuery(rows: unknown[]) {
  const query = {
    from: vi.fn(),
    leftJoin: vi.fn(),
    innerJoin: vi.fn(),
    where: vi.fn(),
    orderBy: vi.fn(),
    limit: vi.fn(async () => rows),
    then: <TResult1 = unknown[], TResult2 = never>(
      onfulfilled?: ((value: unknown[]) => TResult1 | PromiseLike<TResult1>) | null,
      onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
    ) => Promise.resolve(rows).then(onfulfilled, onrejected),
  };
  query.from.mockReturnValue(query);
  query.leftJoin.mockReturnValue(query);
  query.innerJoin.mockReturnValue(query);
  query.where.mockReturnValue(query);
  query.orderBy.mockReturnValue(query);
  return query;
}

function mutationQuery(rows: unknown[]) {
  const query = {
    set: vi.fn(),
    values: vi.fn(),
    where: vi.fn(),
    returning: vi.fn(async () => rows),
  };
  query.set.mockReturnValue(query);
  query.values.mockReturnValue(query);
  query.where.mockReturnValue(query);
  return query;
}

vi.mock("@workspace/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@workspace/db")>();
  mocks.select.mockImplementation(() => selectQuery(mocks.selectResults.shift() ?? []));
  mocks.update.mockImplementation(() => mutationQuery(mocks.updateResults.shift() ?? []));
  mocks.insert.mockImplementation(() => mutationQuery(mocks.insertResults.shift() ?? []));
  return {
    ...actual,
    db: {
      select: mocks.select,
      update: mocks.update,
      insert: mocks.insert,
    },
  };
});

vi.mock("../lib/adminAuth", () => ({
  requireAdmin: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    req.staffPrincipal = {
      userId: req.userId!,
      role: "support",
      source: "user_roles",
      grantedBy: "owner",
    };
    next();
  },
  resolveStaffPrincipal: vi.fn(async (userId: string) => ({
    userId,
    role: "support",
    source: "user_roles",
    grantedBy: "owner",
  })),
  writeAdminReceipt: vi.fn(),
}));

vi.mock("../lib/clerk-users", () => ({
  getSharedAccountProfile: vi.fn(async () => ({
    displayName: "Support Person",
    imageUrl: "https://images.example.test/staff.png",
  })),
}));

vi.mock("../lib/support-access", () => ({
  effectiveSupportGrantStatus: (grant: { status: string; expiresAt: Date | null }, now: Date) =>
    grant.expiresAt && grant.expiresAt <= now ? "expired" : grant.status,
  MAX_SUPPORT_GRANT_MS: 24 * 60 * 60 * 1000,
  presentSupportGrants: vi.fn((rows: unknown[]) => rows),
  recordSupportGrantEvent: mocks.recordSupportGrantEvent,
}));

vi.mock("../lib/project-lifecycle", () => ({
  withActiveProjectLifecycle: mocks.withActiveProjectLifecycle,
}));

vi.mock("../lib/emailTemplates", () => ({
  supportAccessRequestTemplate: vi.fn(() => ({ subject: "subject", html: "html", text: "text" })),
}));

vi.mock("../lib/support-user-delivery", () => ({
  deliverSupportConsequence: mocks.deliverSupportConsequence,
  supportProductUrl: vi.fn((path: string) => `https://preview.example.test${path}`),
}));

import supportAccessRouter from "./support-access";

function appAs(userId: string) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.userId = userId;
    next();
  });
  app.use(supportAccessRouter);
  return app;
}

const ticket = {
  id: 17,
  userId: "project-owner",
  userEmail: "owner@example.test",
  projectId: 51,
  projectName: "Example project",
  projectOwnerId: "project-owner",
};

const pendingGrant = {
  id: 23,
  ticketId: 17,
  projectId: 51,
  ownerUserId: "project-owner",
  staffUserId: "support-user",
  requestedBy: "support-user",
  reason: "Investigate the reported preview failure",
  status: "pending",
  requestedAt: new Date("2026-08-31T00:00:00.000Z"),
  decidedAt: null,
  expiresAt: new Date("2099-08-31T00:00:00.000Z"),
  revokedAt: null,
  closedAt: null,
};

describe("support grant project lifecycle admission", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.selectResults = [];
    mocks.updateResults = [];
    mocks.insertResults = [];
    mocks.deliverSupportConsequence.mockResolvedValue({ emailStatus: "sent" });
  });

  it("creates no pending grant when Trash wins after the ticket read", async () => {
    mocks.selectResults = [[ticket]];
    mocks.withActiveProjectLifecycle.mockResolvedValue({ state: "inactive" });

    const response = await request(appAs("support-user"))
      .post("/admin/support-tickets/17/access-request")
      .send({ reason: "Investigate the reported preview failure" });

    expect(response.status).toBe(409);
    expect(response.body.code).toBe("support_project_not_consentable");
    expect(mocks.withActiveProjectLifecycle).toHaveBeenCalledWith(51, expect.any(Function));
    expect(mocks.insert).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.recordSupportGrantEvent).not.toHaveBeenCalled();
    expect(mocks.deliverSupportConsequence).not.toHaveBeenCalled();
  });

  it("keeps the pending grant and bounded delivery under one lifecycle decision", async () => {
    let insideLifecycle = false;
    mocks.selectResults = [[ticket]];
    mocks.updateResults = [[]];
    mocks.insertResults = [[pendingGrant]];
    mocks.withActiveProjectLifecycle.mockImplementation(async (_projectId, work) => {
      insideLifecycle = true;
      const value = await work({ projectId: 51 });
      insideLifecycle = false;
      return { state: "active", value };
    });
    mocks.insert.mockImplementation(() => {
      expect(insideLifecycle).toBe(true);
      return mutationQuery(mocks.insertResults.shift() ?? []);
    });
    mocks.deliverSupportConsequence.mockImplementation(async () => {
      expect(insideLifecycle).toBe(true);
      return { emailStatus: "sent" };
    });

    const response = await request(appAs("support-user"))
      .post("/admin/support-tickets/17/access-request")
      .send({ reason: "Investigate the reported preview failure" });

    expect(response.status).toBe(201);
    expect(response.body.grant.id).toBe(23);
    expect(mocks.insert).toHaveBeenCalledTimes(1);
    expect(mocks.recordSupportGrantEvent).toHaveBeenCalledWith(
      expect.objectContaining({ event: "access_requested", projectId: 51 }),
    );
    expect(mocks.deliverSupportConsequence).toHaveBeenCalledTimes(1);
  });

  it("cannot activate a pending grant when Trash wins before the owner decision", async () => {
    mocks.selectResults = [[pendingGrant]];
    mocks.withActiveProjectLifecycle.mockResolvedValue({ state: "inactive" });

    const response = await request(appAs("project-owner"))
      .post("/support/access-requests/23/decision")
      .send({ decision: "grant", durationMinutes: 60 });

    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: "Access request not found." });
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.recordSupportGrantEvent).not.toHaveBeenCalled();
  });

  it("activates a grant only after re-reading it inside the lifecycle session", async () => {
    let insideLifecycle = false;
    const activeGrant = {
      ...pendingGrant,
      status: "active",
      decidedAt: new Date("2026-08-31T01:00:00.000Z"),
    };
    mocks.selectResults = [[pendingGrant], [pendingGrant]];
    mocks.updateResults = [[activeGrant]];
    mocks.withActiveProjectLifecycle.mockImplementation(async (_projectId, work) => {
      insideLifecycle = true;
      const value = await work({ projectId: 51 });
      insideLifecycle = false;
      return { state: "active", value };
    });
    mocks.update.mockImplementation(() => {
      expect(insideLifecycle).toBe(true);
      return mutationQuery(mocks.updateResults.shift() ?? []);
    });

    const response = await request(appAs("project-owner"))
      .post("/support/access-requests/23/decision")
      .send({ decision: "grant", durationMinutes: 60 });

    expect(response.status).toBe(200);
    expect(response.body.grant.status).toBe("active");
    expect(mocks.select).toHaveBeenCalledTimes(2);
    expect(mocks.update).toHaveBeenCalledTimes(1);
    expect(mocks.recordSupportGrantEvent).toHaveBeenCalledWith(
      expect.objectContaining({ event: "access_granted", projectId: 51 }),
    );
  });
});
