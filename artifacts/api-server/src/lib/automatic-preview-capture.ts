import { createHash } from "node:crypto";
import { bindPreviewVersion, type PreviewVersionWitness } from "./preview-version-provenance";

export const AUTOMATIC_PREVIEW_SCHEMA = "automatic-project-preview/v1";
export const AUTOMATIC_PREVIEW_SOURCE = "automatic-preview";
export const AUTOMATIC_PREVIEW_MAX_BYTES = 4 * 1024 * 1024;
export const AUTOMATIC_PREVIEW_MAX_ATTEMPTS = 3;
export const AUTOMATIC_PREVIEW_VIEWPORT = { width: 1280, height: 800 } as const;

export type AutomaticPreviewTarget = {
  projectId: number;
  versionId: number;
  cleanupOnly?: boolean;
};
export type AutomaticPreviewProject = { id: number; ownerId: string };
export type AutomaticPreviewAttempt = {
  id: number;
  storageKey: string;
  state: string;
  createdAt: Date;
  needsCleanup: boolean;
};
export type AutomaticPreviewReservation = { id: number; storageKey: string };
export type AutomaticPreviewResult =
  | { state: "ready" | "existing"; assetId: number }
  | {
      state: "skipped";
      reason:
        | "inactive"
        | "not-ready"
        | "superseded"
        | "removed"
        | "attempt-limit"
        | "cleanup-only"
        | "disabled";
    };

export interface AutomaticPreviewSession {
  assertActive(): Promise<boolean>;
}

export interface AutomaticPreviewDependencies {
  withProject<T>(
    projectId: number,
    work: (session: AutomaticPreviewSession) => Promise<T>,
  ): Promise<{ state: "active"; value: T } | { state: "inactive" }>;
  loadProject(target: AutomaticPreviewTarget): Promise<AutomaticPreviewProject | null>;
  admit(target: AutomaticPreviewTarget): Promise<boolean>;
  readWitness(project: AutomaticPreviewProject): Promise<PreviewVersionWitness | null>;
  readAttempts(
    target: AutomaticPreviewTarget,
    ownerId: string,
    key: string,
  ): Promise<AutomaticPreviewAttempt[]>;
  reserve(
    project: AutomaticPreviewProject,
    witness: PreviewVersionWitness,
    key: string,
  ): Promise<AutomaticPreviewReservation>;
  begin(asset: AutomaticPreviewReservation, project: AutomaticPreviewProject): Promise<boolean>;
  capture(witness: PreviewVersionWitness, signal: AbortSignal): Promise<unknown>;
  upload(asset: AutomaticPreviewReservation, bytes: Buffer, signal: AbortSignal): Promise<void>;
  complete(
    asset: AutomaticPreviewReservation,
    project: AutomaticPreviewProject,
    bytes: Buffer,
  ): Promise<void>;
  cleanup(asset: AutomaticPreviewReservation, project: AutomaticPreviewProject): Promise<void>;
  track(projectId: number, controller: AbortController): () => void;
}

export class AutomaticPreviewError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "AutomaticPreviewError";
  }
}

function positiveId(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0 && Number(value) <= 2_147_483_647;
}

export function automaticPreviewKey(target: AutomaticPreviewTarget): string {
  if (!positiveId(target.projectId) || !positiveId(target.versionId)) {
    throw new AutomaticPreviewError("automatic_preview_invalid_target");
  }
  return createHash("sha256")
    .update(
      JSON.stringify([
        AUTOMATIC_PREVIEW_SCHEMA,
        target.projectId,
        target.versionId,
        "/",
        AUTOMATIC_PREVIEW_VIEWPORT.width,
        AUTOMATIC_PREVIEW_VIEWPORT.height,
      ]),
    )
    .digest("hex");
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Treat even a signed provider response as untrusted until bytes and identity agree. */
export function decodeAutomaticPreview(value: unknown, witness: PreviewVersionWitness): Buffer {
  const response = record(value);
  const capture = record(response?.capture);
  if (
    response?.ok !== true ||
    !capture ||
    capture.mimeType !== "image/png" ||
    capture.runtimeIdentity !== witness.runtimeIdentity ||
    capture.manifestRevision !== witness.manifestRevision ||
    capture.sealedArtifactSha256 !== witness.sealedArtifactSha256 ||
    capture.route !== "/" ||
    capture.width !== AUTOMATIC_PREVIEW_VIEWPORT.width ||
    capture.height !== AUTOMATIC_PREVIEW_VIEWPORT.height ||
    typeof capture.base64 !== "string" ||
    capture.base64.length > Math.ceil(AUTOMATIC_PREVIEW_MAX_BYTES / 3) * 4
  ) {
    throw new AutomaticPreviewError("automatic_preview_invalid_response");
  }

  const png = Buffer.from(capture.base64, "base64");
  if (
    png.length < 33 ||
    png.length > AUTOMATIC_PREVIEW_MAX_BYTES ||
    png.toString("base64") !== capture.base64 ||
    png.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a" ||
    png.readUInt32BE(8) !== 13 ||
    png.toString("ascii", 12, 16) !== "IHDR" ||
    png.readUInt32BE(16) !== AUTOMATIC_PREVIEW_VIEWPORT.width ||
    png.readUInt32BE(20) !== AUTOMATIC_PREVIEW_VIEWPORT.height ||
    capture.sha256 !== createHash("sha256").update(png).digest("hex")
  ) {
    throw new AutomaticPreviewError("automatic_preview_invalid_png");
  }
  return png;
}

function needsCleanup(attempt: AutomaticPreviewAttempt): boolean {
  return (
    attempt.state === "reserved" ||
    attempt.state === "uploading" ||
    (attempt.state === "rejected" && attempt.needsCleanup)
  );
}

/**
 * The asset registry is the durable attempt ledger, not the expiring pg-boss row.
 * Recovery closes the durable write gate before admitting another capture.
 * Age and local cancellation never prove that a remote PUT has finished.
 */
export function createAutomaticPreviewRunner(dependencies: AutomaticPreviewDependencies) {
  return async (target: AutomaticPreviewTarget): Promise<AutomaticPreviewResult> => {
    const key = automaticPreviewKey(target);
    const result = await dependencies.withProject(
      target.projectId,
      async (session): Promise<AutomaticPreviewResult> => {
        const project = await dependencies.loadProject(target);
        if (!project || project.id !== target.projectId || !project.ownerId.trim()) {
          return { state: "skipped", reason: "inactive" };
        }
        const controller = new AbortController();
        const untrack = dependencies.track(project.id, controller);
        const timer = setTimeout(() => controller.abort(), 90_000);
        timer.unref?.();
        const assertActive = async () => {
          if (
            controller.signal.aborted ||
            !(await session.assertActive()) ||
            controller.signal.aborted
          ) {
            throw new AutomaticPreviewError("automatic_preview_project_inactive");
          }
        };
        try {
          await assertActive();
          let attempts = await dependencies.readAttempts(target, project.ownerId, key);
          for (const attempt of attempts) {
            if (needsCleanup(attempt)) {
              await assertActive();
              // Storage must fence future writes and require terminal PUT proof.
              // An unresolved write throws, retaining its row and reserved quota.
              await dependencies.cleanup(attempt, project);
            }
          }

          await assertActive();
          // Cleanup may have waited behind a successful final COMMIT. Never use
          // the pre-cleanup snapshot for readiness, deletion or attempt budgets.
          attempts = await dependencies.readAttempts(target, project.ownerId, key);
          const removed = attempts.some(
            (attempt) => attempt.state === "deleted" || attempt.state === "deleting",
          );
          if (removed) return { state: "skipped", reason: "removed" };
          const existing = attempts.find((attempt) => attempt.state === "ready");
          if (existing) return { state: "existing", assetId: existing.id };
          if (attempts.some(needsCleanup)) {
            throw new AutomaticPreviewError("automatic_preview_cleanup_pending");
          }
          if (target.cleanupOnly) {
            return { state: "skipped", reason: "cleanup-only" };
          }
          if (attempts.length >= AUTOMATIC_PREVIEW_MAX_ATTEMPTS) {
            return { state: "skipped", reason: "attempt-limit" };
          }
          if (!(await dependencies.admit(target))) {
            return { state: "skipped", reason: "disabled" };
          }

          const before = await dependencies.readWitness(project);
          if (!before || bindPreviewVersion(project.id, before, before).state !== "verified") {
            return { state: "skipped", reason: "not-ready" };
          }
          if (before.versionId !== target.versionId) {
            return { state: "skipped", reason: "superseded" };
          }
          await assertActive();
          const asset = await dependencies.reserve(project, before, key);
          try {
            if (!(await dependencies.begin(asset, project))) {
              throw new AutomaticPreviewError("automatic_preview_reservation_unavailable");
            }
            await assertActive();
            const png = decodeAutomaticPreview(
              await dependencies.capture(before, controller.signal),
              before,
            );
            await assertActive();
            const after = await dependencies.readWitness(project);
            if (bindPreviewVersion(project.id, before, after).state !== "verified") {
              throw new AutomaticPreviewError("automatic_preview_version_changed");
            }
            await dependencies.upload(asset, png, controller.signal);
            await assertActive();
            await dependencies.complete(asset, project, png);
            return { state: "ready", assetId: asset.id };
          } catch (error) {
            try {
              await dependencies.cleanup(asset, project);
            } catch (cleanupError) {
              // Preserve an explicit blocked safety state instead of implying
              // that a timed-out PUT is cancelled or its quota was released.
              throw cleanupError instanceof AutomaticPreviewError
                ? cleanupError
                : new AutomaticPreviewError("automatic_preview_cleanup_pending");
            }
            await assertActive();
            const recovered = await dependencies.readAttempts(target, project.ownerId, key);
            if (
              recovered.some(
                (attempt) => attempt.state === "deleted" || attempt.state === "deleting",
              )
            ) {
              return { state: "skipped", reason: "removed" };
            }
            const ready = recovered.find((attempt) => attempt.state === "ready");
            if (ready) return { state: "existing", assetId: ready.id };
            throw error instanceof AutomaticPreviewError
              ? error
              : new AutomaticPreviewError("automatic_preview_capture_failed");
          }
        } finally {
          clearTimeout(timer);
          untrack();
        }
      },
    );
    return result.state === "active" ? result.value : { state: "skipped", reason: "inactive" };
  };
}
