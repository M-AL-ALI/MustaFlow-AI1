import { describe, expect, it } from "vitest";
import { presentZeroMemoryVersion } from "@workspace/ora-contracts";

describe("zero-memory-version-v1", () => {
  it("marks memories on the declared current lineage as active", () => {
    expect(
      presentZeroMemoryVersion({
        versionId: 158,
        currentVersionId: 163,
        activeVersionIds: new Set([149, 158, 163]),
      }),
    ).toEqual({
      semantics: "zero-memory-version-v1",
      state: "active",
      label: "Current app version",
      versionId: 158,
      currentVersionId: 163,
    });
  });

  it("marks a memory from the abandoned branch as historical after rollback", () => {
    expect(
      presentZeroMemoryVersion({
        versionId: 159,
        currentVersionId: 163,
        activeVersionIds: new Set([149, 158, 163]),
      }),
    ).toMatchObject({ state: "historical", label: "Saved with another version" });
  });

  it.each([
    { versionId: null, currentVersionId: 163 },
    { versionId: 158, currentVersionId: null },
    { versionId: Number.NaN, currentVersionId: 163 },
  ])("fails closed when a binding is unavailable or malformed: %o", (input) => {
    expect(
      presentZeroMemoryVersion({ ...input, activeVersionIds: new Set([158, 163]) }),
    ).toMatchObject({ state: "unbound", label: "Version not verified" });
  });
});
