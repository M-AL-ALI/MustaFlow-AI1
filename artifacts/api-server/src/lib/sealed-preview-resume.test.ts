import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  candidates: [] as Array<{ sealedRelease: unknown }>,
  updateCalls: 0,
}));

vi.mock("drizzle-orm", () => ({
  and: (...parts: unknown[]) => ({ and: parts }),
  desc: (value: unknown) => value,
  eq: (column: unknown, value: unknown) => ({ column, value }),
  isNotNull: (column: unknown) => ({ isNotNull: column }),
}));

vi.mock("@workspace/db", () => {
  const query = {
    from: () => query,
    where: () => query,
    orderBy: () => query,
    limit: () => Promise.resolve(state.candidates),
  };
  return {
    projectVersionsTable: {
      projectId: "project_versions.project_id",
      sealedRelease: "project_versions.sealed_release",
      createdAt: "project_versions.created_at",
    },
    db: {
      select: () => query,
      update: () => {
        state.updateCalls += 1;
        throw new Error("reads_must_not_write");
      },
    },
  };
});

vi.mock("./tenant-runtime-provider", async (importOriginal) => {
  const original = await importOriginal<typeof import("./tenant-runtime-provider")>();
  return { ...original, supportsZeroGeneration: vi.fn(() => true) };
});

import { resumeAcceptedProjectPreview, SealedPreviewResumeError } from "./sealed-preview-resume";
import type { TenantRuntimeProvider } from "./tenant-runtime-provider";

const acceptedRelease = {
  format: "nabuflow.accepted-sealed-release/v1" as const,
  state: "accepted" as const,
  acceptedAt: "2026-08-25T20:00:00.000Z",
  sourceRuntimeIdentity: "nrf-1111111111111111-p52-preview-primary",
  sourceRevision: "source-52",
  manifest: {
    revision: "manifest-52",
    runtime: "node-api" as const,
    buildCommand: ["npm", "run", "build"],
    startCommand: ["node", "dist/src/index.js"],
    servicePort: 8080,
    healthPath: "/healthz",
    resourceProfile: "dev" as const,
    public: false,
  },
  shelfRevisionId: "pantry-2026-08-25.1",
  shelfRootSha256: "1".repeat(64),
  shelfStateRevision: 1,
  dependencyClosureSha256: "2".repeat(64),
  buildId: `pbuild_${"a".repeat(32)}`,
  buildAttestationSha256: "3".repeat(64),
  sealedArtifactSha256: "4".repeat(64),
  artifactRevision: "artifact-52",
  contentSha256: "5".repeat(64),
  appArtifactSha256: "6".repeat(64),
  layerContentSha256s: ["7".repeat(64)],
  declaredCapabilities: [],
};

describe("sealed preview resume", () => {
  beforeEach(() => {
    state.candidates = [];
    state.updateCalls = 0;
  });

  it("resumes the newest valid durable release without writing during selection", async () => {
    state.candidates = [{ sealedRelease: { invalid: true } }, { sealedRelease: acceptedRelease }];
    const start = vi.fn(async () => ({
      identity: acceptedRelease.sourceRuntimeIdentity,
      manifestRevision: acceptedRelease.manifest.revision,
      status: "running" as const,
      endpoint: null,
    }));
    const provider = {
      zeroGenerationStartAcceptedSealedRelease: start,
    } as unknown as TenantRuntimeProvider;

    await expect(resumeAcceptedProjectPreview({ projectId: 52, provider })).resolves.toMatchObject({
      status: "running",
    });
    expect(start).toHaveBeenCalledWith({ projectId: 52, acceptedRelease });
    expect(state.updateCalls).toBe(0);
  });

  it("fails closed when no durable accepted release exists", async () => {
    const provider = {} as TenantRuntimeProvider;
    await expect(resumeAcceptedProjectPreview({ projectId: 52, provider })).rejects.toMatchObject<
      Partial<SealedPreviewResumeError>
    >({ code: "sealed_preview_release_missing" });
    expect(state.updateCalls).toBe(0);
  });
});
