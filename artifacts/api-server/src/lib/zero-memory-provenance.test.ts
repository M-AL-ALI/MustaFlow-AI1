import { describe, expect, it } from "vitest";
import { presentZeroMemoryProvenance, ZERO_MEMORY_CLAIM_KINDS } from "@workspace/ora-contracts";

const receipt = {
  actorUserId: "user-1",
  sourceMessageStartId: 11,
  sourceMessageEndId: 12,
  sourceTaskId: 21,
  sourceVersionId: 31,
  createdAt: "2026-08-26T20:00:00.000Z",
} as const;

describe("Zero memory provenance", () => {
  it.each(ZERO_MEMORY_CLAIM_KINDS)("presents the closed %s claim kind", (claimKind) => {
    const result = presentZeroMemoryProvenance(
      { ...receipt, claimKind },
      { requestingUserId: "user-1", maySeeSourceIdentities: true },
    );
    expect(result.status).toBe("verified");
    expect(result.claimKind).toBe(claimKind);
    expect(result.source).toEqual({
      messageStartId: 11,
      messageEndId: 12,
      taskId: 21,
      versionId: 31,
    });
  });

  it("distinguishes the requesting user from a teammate without exposing actor ids", () => {
    const own = presentZeroMemoryProvenance(
      { ...receipt, claimKind: "stated" },
      { requestingUserId: "user-1", maySeeSourceIdentities: true },
    );
    const teammate = presentZeroMemoryProvenance(
      { ...receipt, claimKind: "stated" },
      { requestingUserId: "user-2", maySeeSourceIdentities: true },
    );
    expect(own.label).toBe("You said");
    expect(teammate.label).toBe("A teammate said");
    expect(JSON.stringify(teammate)).not.toContain("user-1");
  });

  it("keeps source identities private outside an authorized project context", () => {
    const result = presentZeroMemoryProvenance(
      { ...receipt, claimKind: "observed" },
      { requestingUserId: null, maySeeSourceIdentities: false },
    );
    expect(result.status).toBe("verified");
    expect(result.label).toBe("Zero observed");
    expect(result.source).toBeNull();
  });

  it.each([null, "", "claimed", "user-said"])(
    "never guesses provenance for legacy or malformed kind %s",
    (claimKind) => {
      const result = presentZeroMemoryProvenance(
        claimKind === null ? null : { ...receipt, claimKind },
        { requestingUserId: "user-1", maySeeSourceIdentities: true },
      );
      expect(result).toEqual({
        semantics: "zero-memory-provenance-v1",
        status: "unverified",
        claimKind: null,
        label: "Source unverified",
        recordedAt: null,
        source: null,
      });
    },
  );
});
