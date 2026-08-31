import { describe, expect, it, vi } from "vitest";
import { revalidateCustomDomainServingState } from "./custom-domain-serving-state";

describe("custom-domain serving-state revalidation", () => {
  it("does not serve stale cached pointers after Trash restores a project as a draft", () => {
    const stalePublishedCache = {
      id: 42,
      prodContainerUrl: "https://stale-runtime.invalid",
      prodContainerStatus: "running",
      environment: "production",
      suspendedAt: null,
      suspensionReason: null,
      publishedSnapshotId: 149,
    };
    const restoredDraft = {
      id: 42,
      status: "draft",
      prodContainerUrl: null,
      prodContainerStatus: "stopped",
      publishedSnapshotId: null,
    };
    const readR2 = vi.fn();
    const proxyRuntime = vi.fn();

    const current = revalidateCustomDomainServingState(stalePublishedCache, restoredDraft);
    if (current?.publishedSnapshotId) readR2(current.publishedSnapshotId);
    if (current?.prodContainerStatus === "running" && current.prodContainerUrl) {
      proxyRuntime(current.prodContainerUrl);
    }

    expect(current).toBeNull();
    expect(readR2).not.toHaveBeenCalled();
    expect(proxyRuntime).not.toHaveBeenCalled();
  });

  it("replaces cached serving pointers with the current published row", () => {
    const current = revalidateCustomDomainServingState(
      {
        id: 42,
        prodContainerUrl: "https://stale-runtime.invalid",
        prodContainerStatus: "running",
        environment: "production",
        suspendedAt: null,
        suspensionReason: null,
        publishedSnapshotId: 149,
      },
      {
        id: 42,
        status: "published",
        prodContainerUrl: "https://current-runtime.invalid",
        prodContainerStatus: "running",
        publishedSnapshotId: 158,
      },
    );

    expect(current).toMatchObject({
      prodContainerUrl: "https://current-runtime.invalid",
      prodContainerStatus: "running",
      publishedSnapshotId: 158,
    });
  });
});
