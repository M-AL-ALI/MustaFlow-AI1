import { createHash } from "node:crypto";
import type { TaskReport } from "@workspace/db";
import type { BuilderFile } from "./builder";

export class FailedDraftRecoveryError extends Error {
  readonly code = "failed_draft_recovery_unavailable";
  readonly status = 409;
  constructor(
    message = "This retry is no longer available. Open the latest task in Project history; nothing was changed.",
  ) {
    super(message);
    this.name = "FailedDraftRecoveryError";
  }
}

function checkedFiles(value: unknown): BuilderFile[] {
  if (!Array.isArray(value)) throw new FailedDraftRecoveryError();
  const paths = new Set<string>();
  return value.map((file: unknown) => {
    if (
      !file ||
      typeof file !== "object" ||
      !("path" in file) ||
      !("content" in file) ||
      !("mimeType" in file) ||
      typeof file.path !== "string" ||
      typeof file.content !== "string" ||
      typeof file.mimeType !== "string" ||
      !file.path ||
      file.path.startsWith("/") ||
      /^[a-z]:/i.test(file.path) ||
      /[\\\0]/.test(file.path) ||
      file.path.split("/").some((part) => !part || part === "." || part === "..") ||
      paths.has(file.path)
    ) {
      throw new FailedDraftRecoveryError();
    }
    paths.add(file.path);
    return { path: file.path, content: file.content, mimeType: file.mimeType };
  });
}

/** Content identity, independent of row ids and database ordering. */
export function failedDraftFingerprint(files: readonly BuilderFile[]): string {
  const canonical = checkedFiles(files).sort((a, b) =>
    Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)),
  );
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

export function mergeFailedDraftFiles(
  base: readonly BuilderFile[],
  changed: readonly BuilderFile[],
  removed: readonly string[],
): BuilderFile[] {
  const files = new Map(checkedFiles(base).map((file) => [file.path, file]));
  for (const file of checkedFiles(changed)) files.set(file.path, file);
  for (const path of removed) files.delete(path);
  return [...files.values()];
}

export function describeFailedDraft(input: {
  files: readonly BuilderFile[];
  base: readonly BuilderFile[];
  actorUserId: string;
}): NonNullable<TaskReport["sealedFailedDraft"]> {
  if (!input.actorUserId || input.files.length === 0) throw new FailedDraftRecoveryError();
  return {
    schema: 1,
    actorUserId: input.actorUserId,
    baseFingerprint: failedDraftFingerprint(input.base),
    candidateFingerprint: failedDraftFingerprint(input.files),
    fileCount: input.files.length,
  };
}

export interface FailedRetryTask {
  id: number;
  projectId: number;
  status: string;
  prompt: string | null;
  origin?: string | null;
  supportSessionId?: number | null;
  provenanceActorUserId?: string | null;
  report: TaskReport | null;
  stagingSnapshot: unknown;
}

/** Validation only: this helper never executes, commits, applies, or publishes files. */
export function resolveFailedRetry(input: {
  source: FailedRetryTask | undefined;
  projectId: number;
  actorUserId: string;
  ownerUserId: string | null;
  currentFiles: readonly BuilderFile[];
  submittedContent: string;
  /** Present only when revalidating the durable claim at execution. */
  childTaskId?: number;
  expectedBaseFingerprint?: string;
}): {
  content: string;
  files: BuilderFile[] | null;
  binding: NonNullable<TaskReport["retrySource"]>;
} {
  const { source, actorUserId } = input;
  if (
    !source ||
    source.projectId !== input.projectId ||
    source.status !== "failed" ||
    !actorUserId ||
    actorUserId !== input.ownerUserId ||
    source.origin === "ora" ||
    source.origin === "aura" ||
    source.supportSessionId != null ||
    (source.provenanceActorUserId != null && source.provenanceActorUserId !== actorUserId) ||
    (input.childTaskId === undefined
      ? source.report?.retryChildTaskId != null
      : source.report?.retryChildTaskId !== input.childTaskId)
  ) {
    throw new FailedDraftRecoveryError();
  }
  const request = source.prompt?.trim() || source.report?.userRequest?.trim();
  if (!request)
    throw new FailedDraftRecoveryError(
      "The original request is unavailable. Describe the change in chat; nothing was started.",
    );
  const currentFingerprint = failedDraftFingerprint(input.currentFiles);
  const draft = source.report?.sealedFailedDraft;
  const baseFingerprint =
    input.expectedBaseFingerprint ?? draft?.baseFingerprint ?? currentFingerprint;
  if (
    currentFingerprint !== baseFingerprint ||
    (draft &&
      (draft.schema !== 1 ||
        draft.actorUserId !== actorUserId ||
        draft.baseFingerprint !== baseFingerprint))
  ) {
    throw new FailedDraftRecoveryError(
      "The project changed after this draft was created. Start a new request to keep those changes; the draft was not applied.",
    );
  }
  const files = draft ? checkedFiles(source.stagingSnapshot) : null;
  if (
    draft &&
    (!files ||
      files.length !== draft.fileCount ||
      failedDraftFingerprint(files) !== draft.candidateFingerprint)
  ) {
    throw new FailedDraftRecoveryError(
      "The saved draft could not be verified. Nothing was changed.",
    );
  }
  const submitted = input.submittedContent.trim();
  const content =
    submitted === request || !submitted
      ? request
      : submitted.startsWith(request)
        ? submitted
        : request + "\n\nAdditional instructions for this retry:\n" + submitted;
  return { content, files, binding: { taskId: source.id, actorUserId, baseFingerprint } };
}
