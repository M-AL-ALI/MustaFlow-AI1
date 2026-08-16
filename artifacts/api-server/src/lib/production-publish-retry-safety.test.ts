import { describe, expect, it } from "vitest";
import {
  removeUncommittedProductionSnapshot,
  shouldRemoveUncommittedProductionSnapshot,
} from "./production-publish-retry-safety";

describe("production publish retry safety", () => {
  const unreferenced = {
    publishedSnapshotId: 149,
    stagingPublishedSnapshotId: 158,
    testedSnapshotId: 158,
  };

  it("removes a failed publish snapshot that never became durable production state", () => {
    expect(
      shouldRemoveUncommittedProductionSnapshot({
        snapshotVersionId: 159,
        committed: false,
        needsReconciliation: false,
        references: unreferenced,
      }),
    ).toBe(true);
  });

  it("never removes a committed, referenced, or reconciliation-owned snapshot", () => {
    expect(
      shouldRemoveUncommittedProductionSnapshot({
        snapshotVersionId: 159,
        committed: true,
        needsReconciliation: false,
        references: unreferenced,
      }),
    ).toBe(false);
    expect(
      shouldRemoveUncommittedProductionSnapshot({
        snapshotVersionId: 159,
        committed: false,
        needsReconciliation: true,
        references: unreferenced,
      }),
    ).toBe(false);
    expect(
      shouldRemoveUncommittedProductionSnapshot({
        snapshotVersionId: 159,
        committed: false,
        needsReconciliation: false,
        references: { ...unreferenced, publishedSnapshotId: 159 },
      }),
    ).toBe(false);
  });

  it("deletes a failed unreferenced snapshot through the cleanup boundary", async () => {
    const removed: number[] = [];
    await expect(
      removeUncommittedProductionSnapshot({
        snapshotVersionId: 159,
        committed: false,
        needsReconciliation: false,
        loadReferences: async () => unreferenced,
        removeSnapshot: async (snapshotVersionId) => {
          removed.push(snapshotVersionId);
        },
      }),
    ).resolves.toBe(true);
    expect(removed).toEqual([159]);
  });

  it("does not query or delete after a snapshot commits", async () => {
    let queried = false;
    let removed = false;
    await expect(
      removeUncommittedProductionSnapshot({
        snapshotVersionId: 159,
        committed: true,
        needsReconciliation: false,
        loadReferences: async () => {
          queried = true;
          return undefined;
        },
        removeSnapshot: async () => {
          removed = true;
        },
      }),
    ).resolves.toBe(false);
    expect({ queried, removed }).toEqual({ queried: false, removed: false });
  });
});
