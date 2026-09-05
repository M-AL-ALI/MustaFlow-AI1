import { describe, expect, it } from "vitest";
import {
  beginProductionDatabaseReleaseIntent,
  claimProductionDatabaseDispatchIntent,
  completeProductionDatabaseReleaseIntent,
  hasVerifiedProductionDatabaseRelease,
  observeProductionDatabaseProjectIntent,
  parseProductionDatabaseIntent,
} from "../src/production-database-intent";

const now = Date.parse("2026-08-15T12:00:00.000Z");
const owner = { projectId: 42, allocationIdentity: "a".repeat(64) };
const scope = {
  providerOrganizationId: "org-production",
  regionId: "aws-us-east-2",
  historyRetentionSeconds: 604_800,
};

describe("production database ownership and completion proof", () => {
  it("projects enriched RPC inputs to canonical ownership without relaxing strict schemas", () => {
    const enriched = {
      ...owner,
      scope,
      expiresAtMs: now + 10_000,
      ignoredCredential: "synthetic-never-persist",
    };
    const dispatched = claimProductionDatabaseDispatchIntent(null, enriched, scope, now);
    expect(parseProductionDatabaseIntent(dispatched, enriched)).toEqual(dispatched);
    const resolvedInput = { ...enriched, providerProjectId: "owned-project" };
    const known = observeProductionDatabaseProjectIntent(
      dispatched,
      resolvedInput,
      scope,
      resolvedInput.providerProjectId,
      now,
    );
    const releasing = beginProductionDatabaseReleaseIntent(known, enriched, null, now);
    expect(releasing).toMatchObject({ state: "releasing", providerProjectId: "owned-project" });
    expect(JSON.stringify(releasing)).not.toContain("synthetic-never-persist");
    expect(releasing).not.toHaveProperty("expiresAtMs");
    const completed = completeProductionDatabaseReleaseIntent(
      releasing,
      enriched,
      "owned-project",
      now,
    );
    expect(hasVerifiedProductionDatabaseRelease(completed)).toBe(true);
    expect(completed.scope).toBeNull();
    expect(completed.providerProjectId).toBeNull();
  });

  it("never treats missing or old unmarked release metadata as verified absence", () => {
    const missing = beginProductionDatabaseReleaseIntent(null, owner, null, now);
    expect(missing).toMatchObject({ state: "releasing", scope: null, providerProjectId: null });
    expect(hasVerifiedProductionDatabaseRelease(missing)).toBe(false);
    expect(() => completeProductionDatabaseReleaseIntent(missing, owner, undefined, now)).toThrow(
      "production_database_allocation_uncertain",
    );
    const legacy = { ...missing, state: "released" as const };
    expect(hasVerifiedProductionDatabaseRelease(legacy)).toBe(false);
    expect(beginProductionDatabaseReleaseIntent(legacy, owner, null, now).state).toBe("releasing");
    expect(() => completeProductionDatabaseReleaseIntent(legacy, owner, undefined, now)).toThrow(
      "production_database_allocation_uncertain",
    );
  });

  it("requires a matching exact-ID completion and preserves a verified replay", () => {
    const known = observeProductionDatabaseProjectIntent(null, owner, scope, "owned-project", now);
    const releasing = beginProductionDatabaseReleaseIntent(known, owner, null, now);
    expect(() => completeProductionDatabaseReleaseIntent(releasing, owner, undefined, now)).toThrow(
      "production_database_allocation_uncertain",
    );
    expect(() =>
      completeProductionDatabaseReleaseIntent(releasing, owner, "other-project", now),
    ).toThrow("production_database_intent_conflict");
    const completed = completeProductionDatabaseReleaseIntent(
      releasing,
      owner,
      "owned-project",
      now,
    );
    expect(completeProductionDatabaseReleaseIntent(completed, owner, undefined, now)).toEqual(
      completed,
    );
    expect(() => parseProductionDatabaseIntent(completed, { ...owner, projectId: 51 })).toThrow(
      "production_database_intent_conflict",
    );
  });
});
