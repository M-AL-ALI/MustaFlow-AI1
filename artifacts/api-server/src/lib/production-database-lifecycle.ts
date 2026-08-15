import type {
  ProductionDatabaseCapabilityTenantRuntimeProvider,
  TenantRuntimeProvider,
} from "./tenant-runtime-provider";
import { supportsProductionDatabaseCapability } from "./tenant-runtime-provider";

export class ProductionDatabasePublishUnavailableError extends Error {
  readonly code = "production_database_unavailable";

  constructor() {
    super("Production database capability allocation is unavailable");
    this.name = "ProductionDatabasePublishUnavailableError";
  }
}

export async function ensureDeclaredProductionDatabaseCapability(input: {
  provider: ProductionDatabaseCapabilityTenantRuntimeProvider | null;
  projectId: number;
  declaredCapabilities: readonly string[];
}): Promise<void> {
  if (!input.declaredCapabilities.includes("database")) return;
  if (input.provider === null) throw new ProductionDatabasePublishUnavailableError();
  await input.provider.ensureProductionDatabaseCapability({ projectId: input.projectId });
}

/**
 * Hard deletion fence for project-owned production databases.
 * Soft deletion deliberately never calls this helper.
 */
export async function releaseProductionDatabasesForHardDelete(
  provider: TenantRuntimeProvider,
  projectIds: readonly number[],
): Promise<void> {
  if (!supportsProductionDatabaseCapability(provider)) return;
  for (const projectId of projectIds) {
    const released = await provider.releaseProductionDatabaseCapability({ projectId });
    if (!released.verifiedGone) {
      throw new Error("Production database release did not verify provider deletion");
    }
  }
}
