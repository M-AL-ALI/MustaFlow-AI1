import {
  PREVIEW_CAPTURE_FETCH_TIMEOUT_MS,
  PREVIEW_CAPTURE_FORWARD_ORIGIN,
  PREVIEW_CAPTURE_PORT_HEADER,
  PreviewCaptureError,
  assertCaptureRead,
  captureDeadline,
  captureUpstreamHeaders,
  validCapturePort,
  validateCaptureRoute,
} from "./preview-capture-policy";

type CaptureContainer = Pick<
  NonNullable<DurableObjectState["container"]>,
  "running" | "getTcpPort"
>;

/**
 * Native forwarding only. Neither SDK containerFetch nor lifecycle/health repair is invoked.
 * If the container stops between the state check and fetch, the native fetch fails closed.
 */
export async function forwardPreviewCaptureInSandbox(
  container: CaptureContainer | undefined,
  getState: () => Promise<{ status: string }>,
  request: Request,
): Promise<Response> {
  try {
    const url = new URL(request.url);
    const port = Number(request.headers.get(PREVIEW_CAPTURE_PORT_HEADER));
    if (url.origin !== PREVIEW_CAPTURE_FORWARD_ORIGIN || !validCapturePort(port)) {
      throw new PreviewCaptureError(
        400,
        "preview_capture_invalid_request",
        "Invalid internal capture request",
      );
    }
    assertCaptureRead(request);
    validateCaptureRoute(url.pathname + url.search);
    if (!container?.running) {
      throw new PreviewCaptureError(
        503,
        "preview_capture_runtime_unavailable",
        "Capture runtime is not running",
        true,
      );
    }
    const state = await captureDeadline(getState(), PREVIEW_CAPTURE_FETCH_TIMEOUT_MS);
    if (state.status !== "healthy" || !container.running) {
      throw new PreviewCaptureError(
        503,
        "preview_capture_runtime_unavailable",
        "Capture runtime is not healthy",
        true,
      );
    }
    const response = await captureDeadline(
      container
        .getTcpPort(port)
        .fetch("http://tenant.preview.invalid" + url.pathname + url.search, {
          method: request.method,
          headers: captureUpstreamHeaders(request.headers),
          redirect: "manual",
          signal: AbortSignal.timeout(PREVIEW_CAPTURE_FETCH_TIMEOUT_MS),
        }),
      PREVIEW_CAPTURE_FETCH_TIMEOUT_MS,
    );
    if (response.status === 101 || response.headers.has("upgrade")) {
      void response.body?.cancel().catch(() => undefined);
      throw new PreviewCaptureError(
        502,
        "preview_capture_request_blocked",
        "Capture upgrades are blocked",
      );
    }
    return response;
  } catch (error) {
    const failure =
      error instanceof PreviewCaptureError
        ? error
        : new PreviewCaptureError(
            503,
            "preview_capture_runtime_unavailable",
            "Capture runtime forwarding failed",
            true,
          );
    return Response.json(
      { ok: false, code: failure.code },
      {
        status: failure.status,
        headers: { "cache-control": "no-store" },
      },
    );
  }
}
