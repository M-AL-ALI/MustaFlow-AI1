import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { isReverificationHint } from "@clerk/shared/authorization-errors";

import type { ProjectPurgeOperation } from "@workspace/db";
import type { ProjectPurgeAdmission } from "../lib/project-purge";
import {
  createProjectPurgeRouter,
  isRecentClerkFirstFactor,
  projectPurgeDetachmentCategories,
  type ProjectPurgeImpact,
} from "./project-purge";

function operation(overrides: Partial<ProjectPurgeOperation> = {}): ProjectPurgeOperation {
  return {
    id: "purge_abc",
    projectId: 77,
    retirementOperationIdHash: "a".repeat(64),
    trigger: "manual",
    state: "accepted",
    stage: "verify",
    idempotencyKeyHash: "b".repeat(64),
    requestedByHash: "c".repeat(64),
    attemptCount: 0,
    leaseVersion: 0,
    leaseExpiresAt: null,
    dueAt: new Date("2026-09-01T12:00:00.000Z"),
    nextAttemptAt: null,
    failureCode: null,
    failureRetryable: null,
    resourceProgress: {},
    terminalEvidence: null,
    createdAt: new Date("2026-09-01T12:00:00.000Z"),
    updatedAt: new Date("2026-09-01T12:00:00.000Z"),
    startedAt: null,
    terminalAt: null,
    ...overrides,
  };
}

function impact(overrides: Partial<ProjectPurgeImpact> = {}): ProjectPurgeImpact {
  return {
    projectId: 77,
    name: "Weather desk",
    deletedAt: "2026-08-31T12:00:00.000Z",
    purgeDueAt: "2026-09-30T12:00:00.000Z",
    restoreAllowed: true,
    retirementState: "completed",
    purgeState: "scheduled",
    willDelete: ["Project-owned data"],
    willDetach: [
      "Any purchased domain registration; the registration remains yours",
      "Any external GitHub repository; the repository itself is not deleted",
    ],
    requiresReverification: true,
    ...overrides,
  };
}

function dependencies() {
  return {
    readImpact: vi.fn(async (): Promise<ProjectPurgeImpact | null> => impact()),
    acceptManual: vi.fn(
      async (): Promise<ProjectPurgeAdmission> => ({
        accepted: true as const,
        operation: operation(),
      }),
    ),
    readOwnedOperation: vi.fn(async (): Promise<ProjectPurgeOperation | null> => operation()),
    serializeOperation: vi.fn(
      async (): Promise<Record<string, unknown> | null> => ({
        id: "purge_abc",
        projectId: 77,
        state: "accepted",
        stage: "verify",
        trigger: "manual",
        dueAt: "2026-09-01T12:00:00.000Z",
        attemptCount: 0,
        failureCode: null,
        failureRetryable: null,
        retryAllowed: false,
        nextAttemptAt: null,
        terminalEvidence: null,
      }),
    ),
    readCleanupReadiness: vi.fn(async (): Promise<boolean> => true),
    recentlyReverified: vi.fn((): boolean => true),
  };
}

function appAs(userId: string | null, deps: ReturnType<typeof dependencies>) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (userId) req.userId = userId;
    next();
  });
  app.use(createProjectPurgeRouter(deps));
  return app;
}

describe("project permanent-deletion routes", () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([
    [{ hasPurchasedDomain: false, hasGithubConnection: false }, []],
    [
      { hasPurchasedDomain: true, hasGithubConnection: false },
      ["Any purchased domain registration; the registration remains yours"],
    ],
    [
      { hasPurchasedDomain: false, hasGithubConnection: true },
      ["Any external GitHub repository; the repository itself is not deleted"],
    ],
    [
      { hasPurchasedDomain: true, hasGithubConnection: true },
      [
        "Any purchased domain registration; the registration remains yours",
        "Any external GitHub repository; the repository itself is not deleted",
      ],
    ],
  ] as const)("reports only external resources actually attached: %o", (flags, expected) => {
    expect(projectPurgeDetachmentCategories(flags)).toEqual(expected);
  });

  it("accepts only a fresh direct Clerk first factor", () => {
    expect(
      isRecentClerkFirstFactor(
        {
          userId: "owner-77",
          sessionId: "session-1",
          actor: null,
          factorVerificationAge: [9.99, -1],
        },
        "owner-77",
      ),
    ).toBe(true);
    expect(
      isRecentClerkFirstFactor(
        {
          userId: "clerk-migrated-id",
          sessionClaims: { userId: "owner-77" },
          sessionId: "session-1",
          actor: null,
          factorVerificationAge: [0, -1],
        },
        "owner-77",
      ),
    ).toBe(true);
    expect(
      isRecentClerkFirstFactor(
        {
          userId: "owner-77",
          sessionId: "session-1",
          actor: null,
          factorVerificationAge: [10, -1],
        },
        "owner-77",
      ),
    ).toBe(false);
    expect(
      isRecentClerkFirstFactor(
        {
          userId: "other-user",
          sessionId: "session-1",
          actor: null,
          factorVerificationAge: [0, -1],
        },
        "owner-77",
      ),
    ).toBe(false);
    expect(
      isRecentClerkFirstFactor(
        {
          userId: "owner-77",
          sessionId: "session-1",
          actor: { sub: "staff" },
          factorVerificationAge: [0, -1],
        },
        "owner-77",
      ),
    ).toBe(false);
    expect(
      isRecentClerkFirstFactor(
        { userId: "owner-77", sessionId: null, factorVerificationAge: [0, -1] },
        "owner-77",
      ),
    ).toBe(false);
    expect(
      isRecentClerkFirstFactor(
        { userId: "owner-77", sessionId: "session-1", factorVerificationAge: ["0", -1] },
        "owner-77",
      ),
    ).toBe(false);
  });

  it("returns the owner-only deletion impact without mutating", async () => {
    const deps = dependencies();

    const response = await request(appAs("owner-77", deps)).get(
      "/projects/77/permanent-deletion-impact",
    );

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ...impact(), cleanupReady: true });
    expect(response.body.willDetach).toEqual([
      expect.stringContaining("remains yours"),
      expect.stringContaining("not deleted"),
    ]);
    expect(deps.readImpact).toHaveBeenCalledWith(77, "owner-77");
    expect(deps.acceptManual).not.toHaveBeenCalled();
  });

  it("returns no detachment categories when the project has no external resources", async () => {
    const deps = dependencies();
    deps.readImpact.mockResolvedValue(impact({ willDetach: [] }));

    const response = await request(appAs("owner-77", deps)).get(
      "/projects/77/permanent-deletion-impact",
    );

    expect(response.status).toBe(200);
    expect(response.body.willDetach).toEqual([]);
    expect(deps.acceptManual).not.toHaveBeenCalled();
  });

  it.each(["not-a-number", "-7", "0", "999999999999999999999"])(
    "denies hostile project id %s without a lookup",
    async (projectId) => {
      const deps = dependencies();

      const response = await request(appAs("owner-77", deps)).get(
        `/projects/${projectId}/permanent-deletion-impact`,
      );

      expect(response.status).toBe(404);
      expect(response.body).toEqual({ error: "Project not found" });
      expect(deps.readImpact).not.toHaveBeenCalled();
    },
  );

  it("gives a cross-owner the same non-revealing impact response as a missing project", async () => {
    const deps = dependencies();
    deps.readImpact.mockResolvedValue(null);

    const response = await request(appAs("other-owner", deps)).get(
      "/projects/77/permanent-deletion-impact",
    );

    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: "Project not found" });
  });

  it("does not invent an automatic date when the durable schedule is absent", async () => {
    const deps = dependencies();
    deps.readImpact.mockResolvedValue(impact({ purgeDueAt: null, purgeState: null }));

    const response = await request(appAs("owner-77", deps)).get(
      "/projects/77/permanent-deletion-impact",
    );

    expect(response.status).toBe(503);
    expect(response.body.code).toBe("project_purge_schedule_pending");
  });

  it("passes the exact owner name and idempotency key to governed admission", async () => {
    const deps = dependencies();

    const response = await request(appAs("owner-77", deps))
      .delete("/projects/77/permanent")
      .set("Idempotency-Key", "owner-request-0001")
      .send({ projectName: "Weather desk" });

    expect(response.status).toBe(202);
    expect(response.body).toEqual({
      code: "project_purge_accepted",
      operationId: "purge_abc",
      state: "accepted",
      statusUrl: "/api/project-purge-operations/purge_abc",
    });
    expect(deps.acceptManual).toHaveBeenCalledWith({
      projectId: 77,
      userId: "owner-77",
      projectName: "Weather desk",
      idempotencyKey: "owner-request-0001",
      recentlyReverified: true,
    });
  });

  it("checks cleanup readiness before Clerk reverification or purge admission", async () => {
    const deps = dependencies();
    deps.readCleanupReadiness.mockResolvedValue(false);
    deps.recentlyReverified.mockReturnValue(false);

    const response = await request(appAs("owner-77", deps))
      .delete("/projects/77/permanent")
      .set("Idempotency-Key", "owner-request-0001")
      .send({ projectName: "Weather desk" });

    expect(response.status).toBe(503);
    expect(response.body).toEqual({
      code: "project_purge_provider_unavailable",
      error: expect.stringContaining("Sign-in verification has not started"),
      retryable: true,
    });
    expect(deps.recentlyReverified).not.toHaveBeenCalled();
    expect(deps.acceptManual).not.toHaveBeenCalled();
  });

  it("requires server-observed reverification before calling admission", async () => {
    const deps = dependencies();
    deps.recentlyReverified.mockReturnValue(false);

    const response = await request(appAs("owner-77", deps))
      .delete("/projects/77/permanent")
      .set("Idempotency-Key", "owner-request-0001")
      .send({ projectName: "Weather desk" });

    expect(response.status).toBe(403);
    expect(response.body).toEqual({
      clerk_error: {
        type: "forbidden",
        reason: "reverification-error",
        metadata: { reverification: { level: "first_factor", afterMinutes: 10 } },
      },
    });
    expect(isReverificationHint(response.body)).toBe(true);
    expect(deps.acceptManual).not.toHaveBeenCalled();
  });

  it.each([
    ["project_purge_retry_key_reused", "Confirm the project name again"],
    ["project_purge_retry_unavailable", "Contact support"],
    ["project_purge_attempts_exhausted", "retry limit"],
  ] as const)("returns a typed, plain refusal for %s", async (code, message) => {
    const deps = dependencies();
    deps.acceptManual.mockResolvedValue({ accepted: false, code });

    const response = await request(appAs("owner-77", deps))
      .delete("/projects/77/permanent")
      .set("Idempotency-Key", "owner-request-0001")
      .send({ projectName: "Weather desk" });

    expect(response.status).toBe(409);
    expect(response.body).toEqual({ code, error: expect.stringContaining(message) });
  });

  it("keeps an idempotent replay response stable while statusUrl carries current truth", async () => {
    const deps = dependencies();
    deps.acceptManual.mockResolvedValue({
      accepted: true,
      operation: operation({ state: "running", stage: "assets" }),
    });

    const response = await request(appAs("owner-77", deps))
      .delete("/projects/77/permanent")
      .set("Idempotency-Key", "owner-request-0001")
      .send({ projectName: "Weather desk" });

    expect(response.status).toBe(202);
    expect(response.body).toEqual({
      code: "project_purge_accepted",
      operationId: "purge_abc",
      state: "accepted",
      statusUrl: "/api/project-purge-operations/purge_abc",
    });
  });

  it.each([
    {},
    { projectName: "" },
    { projectName: "Weather desk", approval: true },
    { projectName: 77 },
  ])("refuses malformed confirmation body %#", async (body) => {
    const deps = dependencies();

    const response = await request(appAs("owner-77", deps))
      .delete("/projects/77/permanent")
      .set("Idempotency-Key", "owner-request-0001")
      .send(body);

    expect(response.status).toBe(400);
    expect(deps.acceptManual).not.toHaveBeenCalled();
  });

  it("maps cross-owner or missing admission to the same 404", async () => {
    const deps = dependencies();
    deps.acceptManual.mockResolvedValue({
      accepted: false,
      code: "project_purge_not_found",
    });

    const response = await request(appAs("other-owner", deps))
      .delete("/projects/77/permanent")
      .set("Idempotency-Key", "owner-request-0001")
      .send({ projectName: "Weather desk" });

    expect(response.status).toBe(404);
    expect(response.body).toEqual({
      code: "project_purge_not_found",
      error: "Project not found",
    });
  });

  it("returns only a validated owner-scoped operation receipt", async () => {
    const deps = dependencies();

    const response = await request(appAs("owner-77", deps)).get(
      "/project-purge-operations/purge_abc",
    );

    expect(response.status).toBe(200);
    expect(response.body).toEqual(
      expect.objectContaining({ id: "purge_abc", projectId: 77, state: "accepted" }),
    );
    expect(deps.readOwnedOperation).toHaveBeenCalledWith("purge_abc", "owner-77");
  });

  it("does not reveal whether another owner's operation exists", async () => {
    const deps = dependencies();
    deps.readOwnedOperation.mockResolvedValue(null);

    const response = await request(appAs("other-owner", deps)).get(
      "/project-purge-operations/purge_abc",
    );

    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: "Deletion request not found" });
  });

  it("fails closed when stored terminal evidence cannot be validated", async () => {
    const deps = dependencies();
    deps.serializeOperation.mockResolvedValue(null);

    const response = await request(appAs("owner-77", deps)).get(
      "/project-purge-operations/purge_abc",
    );

    expect(response.status).toBe(503);
    expect(response.body.code).toBe("project_purge_receipt_unavailable");
  });
});
