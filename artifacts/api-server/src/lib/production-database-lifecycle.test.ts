import { describe, expect, it, vi } from "vitest";
import type {
  ProductionDatabaseCapabilityTenantRuntimeProvider,
  TenantRuntimeProvider,
} from "./tenant-runtime-provider";
import {
  ensureDeclaredProductionDatabaseCapability,
  ProductionDatabasePublishUnavailableError,
  releaseProductionDatabasesForHardDelete,
} from "./production-database-lifecycle";

function provider(
  release: ProductionDatabaseCapabilityTenantRuntimeProvider["releaseProductionDatabaseCapability"],
): ProductionDatabaseCapabilityTenantRuntimeProvider {
  return {
    providerId: "cloudflare",
    promoteProductionArtifact: vi.fn(),
    rollbackProductionArtifactActivation: vi.fn(),
    zeroGenerationControlRequest: vi.fn(),
    zeroGenerationRuntimeDescriptor: vi.fn(),
    zeroGenerationRuntimeDescriptorForProject: vi.fn(),
    zeroGenerationStartAcceptedSealedRelease: vi.fn(),
    deployArtifact: vi.fn(),
    updateRuntimeManifest: vi.fn(),
    deployLayeredArtifact: vi.fn(),
    ensureProductionDatabaseCapability: vi.fn(),
    releaseProductionDatabaseCapability: release,
  } as unknown as ProductionDatabaseCapabilityTenantRuntimeProvider;
}

describe("production database hard-delete fence", () => {
  it("verifies every provider object is gone before hard deletion can continue", async () => {
    const release = vi.fn(async ({ projectId }: { projectId: number }) => ({
      allocationIdentity: String(projectId).padStart(64, "0"),
      providerProjectId: `provider-${projectId}`,
      verifiedGone: true as const,
    }));
    await expect(
      releaseProductionDatabasesForHardDelete(provider(release), [41, 42]),
    ).resolves.toBe(undefined);
    expect(release.mock.calls.map(([input]) => input.projectId)).toEqual([41, 42]);
  });

  it("leaves Fly and other legacy providers byte-behavior untouched", async () => {
    const legacy = { providerId: "fly" } as TenantRuntimeProvider;
    await expect(releaseProductionDatabasesForHardDelete(legacy, [42])).resolves.toBeUndefined();
  });

  it("fails closed on a provider error before callers delete ownership rows", async () => {
    const release = vi.fn(async () => {
      throw new Error("typed provider terminal");
    });
    await expect(releaseProductionDatabasesForHardDelete(provider(release), [42])).rejects.toThrow(
      "typed provider terminal",
    );
    expect(release).toHaveBeenCalledOnce();
  });
});

describe("production database publish preparation", () => {
  it("allocates before publish only when the accepted release declares database", async () => {
    const ensure = vi.fn(async () => ({
      allocationIdentity: "a".repeat(64),
      revision: "production-database-a",
      providerProjectId: "provider-42",
      reused: false,
    }));
    const capable = provider(vi.fn());
    capable.ensureProductionDatabaseCapability = ensure;

    await ensureDeclaredProductionDatabaseCapability({
      provider: capable,
      projectId: 42,
      declaredCapabilities: [],
    });
    expect(ensure).not.toHaveBeenCalled();

    await ensureDeclaredProductionDatabaseCapability({
      provider: capable,
      projectId: 42,
      declaredCapabilities: ["database"],
    });
    expect(ensure).toHaveBeenCalledExactlyOnceWith({ projectId: 42 });
  });

  it("fails typed before promotion when a database release has no capable provider", async () => {
    await expect(
      ensureDeclaredProductionDatabaseCapability({
        provider: null,
        projectId: 42,
        declaredCapabilities: ["database"],
      }),
    ).rejects.toBeInstanceOf(ProductionDatabasePublishUnavailableError);
  });
});
