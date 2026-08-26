import { and, desc, eq, isNotNull } from "drizzle-orm";
import { db, projectVersionsTable } from "@workspace/db";
import {
  acceptedSealedReleaseSchema,
  type AcceptedSealedRelease,
} from "@workspace/tenant-runtime-contracts";
import {
  supportsZeroGeneration,
  type RuntimeStatus,
  type TenantRuntimeProvider,
} from "./tenant-runtime-provider";

const ACCEPTED_RELEASE_LOOKBACK = 32;

export class SealedPreviewResumeError extends Error {
  constructor(
    public readonly code: "sealed_preview_provider_unavailable" | "sealed_preview_release_missing",
    message: string,
  ) {
    super(message);
    this.name = "SealedPreviewResumeError";
  }
}

/**
 * Resume the newest durable accepted preview release for a project.
 *
 * This is a governed mutation helper. The accepted release is the authority;
 * current draft files and process-local artifact caches are never substitutes.
 */
export async function resumeAcceptedProjectPreview(input: {
  projectId: number;
  provider: TenantRuntimeProvider;
}): Promise<{
  identity: string;
  manifestRevision: string;
  status: RuntimeStatus;
  endpoint: string | null;
}> {
  if (!supportsZeroGeneration(input.provider)) {
    throw new SealedPreviewResumeError(
      "sealed_preview_provider_unavailable",
      "The active runtime provider cannot resume sealed previews",
    );
  }

  const candidates = await db
    .select({ sealedRelease: projectVersionsTable.sealedRelease })
    .from(projectVersionsTable)
    .where(
      and(
        eq(projectVersionsTable.projectId, input.projectId),
        isNotNull(projectVersionsTable.sealedRelease),
      ),
    )
    .orderBy(desc(projectVersionsTable.createdAt))
    .limit(ACCEPTED_RELEASE_LOOKBACK);

  let release: AcceptedSealedRelease | null = null;
  for (const candidate of candidates) {
    const parsed = acceptedSealedReleaseSchema.safeParse(candidate.sealedRelease);
    if (parsed.success) {
      release = parsed.data;
      break;
    }
  }
  if (release === null) {
    throw new SealedPreviewResumeError(
      "sealed_preview_release_missing",
      "No accepted sealed preview release is available",
    );
  }

  return input.provider.zeroGenerationStartAcceptedSealedRelease({
    projectId: input.projectId,
    acceptedRelease: release,
  });
}
