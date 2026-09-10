import { describe, expect, it } from "vitest";
import {
  isPreviewAuthorizationStatus,
  isTerminalPreviewRecoveryError,
  presentPreviewRecovery,
  readPreviewRecoveryError,
  reconcilePreviewRecoveryError,
} from "./preview-recovery-presentation";

const rebuildBody = {
  code: "preview_rebuild_required",
  error: "This preview needs a fresh build before it can be opened.",
};
const rebuildError = readPreviewRecoveryError({ status: 409, data: rebuildBody });

describe("production preview recovery presentation", () => {
  it("keeps transient status reads retryable and stops terminal failures", () => {
    for (const error of [
      new Error("Network unavailable"),
      { status: 503 },
      { status: 408 },
      { status: 429 },
    ]) {
      expect(isTerminalPreviewRecoveryError(readPreviewRecoveryError(error))).toBe(false);
    }
    for (const error of [
      { status: 401 },
      { status: 403 },
      { status: 404 },
      { status: 409, data: rebuildBody },
    ]) {
      expect(isTerminalPreviewRecoveryError(readPreviewRecoveryError(error))).toBe(true);
    }
  });

  it("retains the exact structured rebuild-required failure", () => {
    expect(rebuildError).toEqual({
      kind: "rebuild-required",
      code: rebuildBody.code,
      message: rebuildBody.error,
      httpStatus: 409,
    });
    expect(readPreviewRecoveryError(rebuildBody).kind).toBe("rebuild-required");
    expect(readPreviewRecoveryError({ status: 409, body: rebuildBody }).kind).toBe(
      "rebuild-required",
    );
    expect(readPreviewRecoveryError(new Error(JSON.stringify(rebuildBody))).kind).toBe(
      "rebuild-required",
    );
  });

  it("does not invent rebuild causes from messages or unrelated conflicts", () => {
    for (const error of [
      new Error(rebuildBody.error),
      { status: 409, data: { code: "candidate-needs-attention" } },
      { status: 409, data: { error: "Unauthorized" } },
      { status: 500, data: rebuildBody },
      null,
    ]) {
      expect(readPreviewRecoveryError(error).kind).toBe("check-failed");
    }
  });

  it.each(["stopped", "hibernated", "starting", "running"])(
    "keeps rebuild recovery when status refresh says %s with unavailable access",
    (containerStatus) => {
      const retained = reconcilePreviewRecoveryError(rebuildError, {
        containerStatus,
        previewAccess: "unavailable",
      });
      expect(retained).toBe(rebuildError);
      expect(
        presentPreviewRecovery({
          status: "stopped",
          hasRuntime: true,
          error: retained,
        }),
      ).toMatchObject({ action: "test", actionLabel: "Start test" });
    },
  );

  it("requires both running runtime and server access to clear rebuild recovery", () => {
    expect(
      reconcilePreviewRecoveryError(rebuildError, {
        containerStatus: "starting",
        previewAccess: "direct",
      }),
    ).toBe(rebuildError);
    expect(reconcilePreviewRecoveryError(rebuildError, {})).toBe(rebuildError);
    for (const previewAccess of ["direct", "gateway"] as const) {
      expect(
        reconcilePreviewRecoveryError(rebuildError, {
          containerStatus: "running",
          previewAccess,
        }),
      ).toBeNull();
    }
  });

  it("routes a sealed candidate to rebuild without substituting wake or approval", () => {
    expect(
      presentPreviewRecovery({
        status: "hibernated",
        hasRuntime: true,
        error: rebuildError,
        testingCandidateSnapshotId: 600,
      }),
    ).toMatchObject({
      action: "test",
      actionLabel: "Rebuild test",
      statusLabel: "Preview rebuild required",
      disabled: false,
    });
    expect(
      presentPreviewRecovery({
        hasRuntime: true,
        error: rebuildError,
        testingBusy: true,
      }),
    ).toMatchObject({ action: "test", disabled: true });
    expect(presentPreviewRecovery({ hasRuntime: false, error: rebuildError }).action).toBeNull();
  });

  it.each([401, 403])("identifies actual HTTP %s as access denial", (status) => {
    const error = readPreviewRecoveryError({ status, data: rebuildBody });
    expect(error.kind).toBe("unauthorized");
    expect(isPreviewAuthorizationStatus(status)).toBe(true);
    expect(presentPreviewRecovery({ hasRuntime: true, error })).toMatchObject({
      title: "Preview access denied",
      action: "retry",
    });
    expect(reconcilePreviewRecoveryError(error, { containerStatus: "stopped" })).toBeNull();
  });

  it("never treats unavailable access or a provisioned but stopped runtime as unauthorized or live", () => {
    expect(isPreviewAuthorizationStatus(200)).toBe(false);
    expect(isPreviewAuthorizationStatus("unavailable")).toBe(false);
    const presentation = presentPreviewRecovery({ hasRuntime: true, status: "stopped" });
    expect(presentation).toMatchObject({
      title: "Your preview is offline",
      action: "wake",
      statusLabel: null,
    });
  });

  it("lets a real preview access denial take precedence without changing the retained error", () => {
    expect(
      presentPreviewRecovery({
        hasRuntime: true,
        error: rebuildError,
        authorizationStatus: 403,
      }),
    ).toMatchObject({ title: "Preview access denied", action: "retry" });
    expect(rebuildError.kind).toBe("rebuild-required");
  });
});
