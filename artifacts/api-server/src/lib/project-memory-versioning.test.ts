import { describe, expect, it } from "vitest";
import { deriveProjectMemoryVersionLineage } from "./project-memory-versioning-contract";

describe("project memory version lineage", () => {
  it("follows the ordinary app-version chain", () => {
    const result = deriveProjectMemoryVersionLineage({
      currentVersionId: 3,
      versions: [
        { id: 1, parentVersionId: null },
        { id: 2, parentVersionId: 1 },
        { id: 3, parentVersionId: 2 },
      ],
    });
    expect([...result.activeVersionIds]).toEqual([3, 2, 1]);
    expect(result.coverage).toBe("complete");
  });

  it("abandons newer-branch memories when a rollback revision points at the restored version", () => {
    const result = deriveProjectMemoryVersionLineage({
      currentVersionId: 5,
      versions: [
        { id: 1, parentVersionId: null },
        { id: 2, parentVersionId: 1 },
        { id: 3, parentVersionId: 2 },
        { id: 4, parentVersionId: 3 },
        { id: 5, parentVersionId: 2 },
      ],
    });
    expect([...result.activeVersionIds]).toEqual([5, 2, 1]);
    expect(result.activeVersionIds.has(3)).toBe(false);
    expect(result.activeVersionIds.has(4)).toBe(false);
  });

  it.each([
    {
      name: "missing parent",
      currentVersionId: 3,
      versions: [{ id: 3, parentVersionId: 2 }],
    },
    {
      name: "cycle",
      currentVersionId: 3,
      versions: [
        { id: 3, parentVersionId: 2 },
        { id: 2, parentVersionId: 3 },
      ],
    },
  ])("fails closed with limited coverage for $name", ({ currentVersionId, versions }) => {
    expect(deriveProjectMemoryVersionLineage({ currentVersionId, versions }).coverage).toBe(
      "limited",
    );
  });
});
