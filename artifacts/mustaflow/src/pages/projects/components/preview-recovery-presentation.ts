import {
  hasServerPreviewAccess,
  presentAgenticPreviewUnavailable,
  type PreviewRuntimeStatus,
} from "@/lib/preview-access-ui";

export type PreviewRecoveryError = {
  kind: "rebuild-required" | "unauthorized" | "check-failed";
  code: string;
  message: string;
  httpStatus: number | null;
};

function errorRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value === "string") {
    try {
      return errorRecord(JSON.parse(value));
    } catch {
      return null;
    }
  }
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function isPreviewAuthorizationStatus(status: unknown): status is 401 | 403 {
  return status === 401 || status === 403;
}

/** Status reads may retry transient transport, server, timeout and rate-limit failures. */
export function isTerminalPreviewRecoveryError(error: PreviewRecoveryError): boolean {
  if (error.kind === "unauthorized" || error.kind === "rebuild-required") return true;
  const status = error.httpStatus;
  return status !== null && status >= 400 && status < 500 && status !== 408 && status !== 429;
}

/** Read structured failure codes, never infer rebuild or auth failures from prose. */
export function readPreviewRecoveryError(error: unknown): PreviewRecoveryError {
  const envelope = errorRecord(error);
  const body =
    errorRecord(envelope?.data) ??
    errorRecord(envelope?.body) ??
    errorRecord(envelope?.message) ??
    envelope;
  const httpStatus = typeof envelope?.status === "number" ? envelope.status : null;
  const code = typeof body?.code === "string" ? body.code : "preview_check_failed";
  if (isPreviewAuthorizationStatus(httpStatus)) {
    return {
      kind: "unauthorized",
      code,
      httpStatus,
      message:
        httpStatus === 401
          ? "Your session could not access the preview. Sign in again, then check its status."
          : "Your account does not have permission to access this preview.",
    };
  }
  if (code === "preview_rebuild_required" && (httpStatus === 409 || httpStatus === null)) {
    return {
      kind: "rebuild-required",
      code,
      httpStatus,
      message:
        typeof body?.error === "string" && body.error.trim()
          ? body.error
          : "This preview needs a fresh build before it can be opened.",
    };
  }
  return {
    kind: "check-failed",
    code,
    httpStatus,
    message: "The preview request could not be completed. Check its status again.",
  };
}

/** A stopped status receipt does not resolve a rejected wake's rebuild requirement. */
export function reconcilePreviewRecoveryError(
  current: PreviewRecoveryError | null,
  receipt: {
    containerStatus?: string | null;
    previewAccess?: "direct" | "gateway" | "unavailable" | null;
  },
): PreviewRecoveryError | null {
  if (
    current?.kind === "rebuild-required" &&
    !(
      receipt.containerStatus === "running" &&
      hasServerPreviewAccess(receipt.previewAccess ?? undefined)
    )
  ) {
    return current;
  }
  return null;
}

export type PreviewRecoveryPresentation = {
  title: string;
  message: string;
  action: "wake" | "retry" | "test" | null;
  actionLabel: string | null;
  statusLabel: string | null;
  disabled: boolean;
};

export function presentPreviewRecovery(input: {
  status?: PreviewRuntimeStatus;
  hasRuntime: boolean;
  error?: PreviewRecoveryError | null;
  authorizationStatus?: 401 | 403 | null;
  testingCandidateSnapshotId?: number | null;
  testingBusy?: boolean;
}): PreviewRecoveryPresentation {
  const error = isPreviewAuthorizationStatus(input.authorizationStatus)
    ? readPreviewRecoveryError({ status: input.authorizationStatus })
    : input.error;
  if (error?.kind === "unauthorized") {
    return {
      title: "Preview access denied",
      message: error.message,
      action: "retry",
      actionLabel: "Check preview access",
      statusLabel: "Preview access denied",
      disabled: false,
    };
  }
  if (error?.kind === "rebuild-required") {
    return {
      title: "Preview rebuild required",
      message:
        error.message +
        " Start or rebuild a test preview, then review its result before publishing.",
      action: input.hasRuntime ? "test" : null,
      actionLabel: !input.hasRuntime
        ? null
        : input.testingBusy
          ? "Testing..."
          : input.testingCandidateSnapshotId != null
            ? "Rebuild test"
            : "Start test",
      statusLabel: "Preview rebuild required",
      disabled: Boolean(input.testingBusy),
    };
  }
  const fallback = presentAgenticPreviewUnavailable(
    error?.kind === "check-failed" ? "error" : input.status,
  );
  return {
    ...fallback,
    ...(fallback.action === "wake" && !input.hasRuntime
      ? { action: "retry" as const, actionLabel: "Check status" }
      : {}),
    statusLabel: error?.kind === "check-failed" ? "Preview check failed" : null,
    disabled: fallback.action === null,
  };
}
