import { Buffer } from "node:buffer";
import {
  canonicalJson,
  controlErrorResponseSchema,
  parseRuntimeIdentityForNamespace,
  sha256Hex,
} from "@workspace/tenant-runtime-contracts";
import type { WorkerBindings } from "./bindings";
import type { ControlCoordinator, StoredRuntime } from "./model";
import { runtimeSandboxStub } from "./runtime-backend";
import {
  PREVIEW_CAPTURE_HEADER,
  PREVIEW_CAPTURE_FORWARD_ORIGIN,
  PREVIEW_CAPTURE_PORT_HEADER,
  PREVIEW_CAPTURE_TTL_MS,
  PREVIEW_CAPTURE_PROVIDER_TIMEOUT_MS,
  PREVIEW_CAPTURE_FETCH_TIMEOUT_MS,
  PREVIEW_CAPTURE_MAX_PNG_BYTES,
  PREVIEW_CAPTURE_MAX_RESOURCE_BYTES,
  PreviewCaptureError,
  assertCaptureRead,
  captureDeadline,
  captureMarker,
  captureOrigin,
  captureUpstreamHeaders,
  parsePreviewCaptureInput,
  readCaptureBytes,
  signCaptureCredential,
  validCapturePort,
  validateCaptureRoute,
  verifyCaptureCredential,
  type PreviewCaptureClaims,
  type PreviewCaptureInput,
} from "./preview-capture-policy";

export { PreviewCaptureError } from "./preview-capture-policy";

interface CaptureDependencies {
  coordinator: ControlCoordinator;
  nowMs?: number;
  requestId?: string;
}

type CaptureWitness = Pick<
  PreviewCaptureInput,
  "runtimeIdentity" | "manifestRevision" | "sealedArtifactSha256"
>;

async function captureRuntime(
  input: CaptureWitness,
  projectId: number,
  env: WorkerBindings,
  coordinator: ControlCoordinator,
): Promise<{ runtime: StoredRuntime; witnessSha256: string }> {
  let identity;
  try {
    identity = await parseRuntimeIdentityForNamespace(
      input.runtimeIdentity,
      env.CLOUDFLARE_RUNTIME_DEPLOYMENT_NAMESPACE,
    );
  } catch {
    throw new PreviewCaptureError(
      400,
      "preview_capture_selector_mismatch",
      "Capture runtime selector is invalid",
    );
  }
  if (
    !Number.isSafeInteger(projectId) ||
    projectId < 1 ||
    identity.projectId !== projectId ||
    identity.role !== "preview" ||
    identity.slot !== "primary"
  ) {
    throw new PreviewCaptureError(
      400,
      "preview_capture_selector_mismatch",
      "Capture requires this project's primary preview runtime",
    );
  }
  const runtime = await coordinator.getRuntime(input.runtimeIdentity);
  if (!runtime || runtime.descriptor.status !== "running" || !runtime.processId) {
    throw new PreviewCaptureError(
      409,
      "preview_capture_runtime_unavailable",
      "Capture runtime is not running",
      true,
    );
  }
  if (
    runtime.descriptor.identity !== input.runtimeIdentity ||
    runtime.descriptor.projectId !== projectId ||
    runtime.descriptor.role !== "preview" ||
    runtime.descriptor.slot !== "primary" ||
    runtime.manifest.public !== false ||
    runtime.descriptor.manifestRevision !== input.manifestRevision ||
    runtime.manifest.revision !== input.manifestRevision ||
    runtime.artifactSha256 !== input.sealedArtifactSha256 ||
    runtime.descriptor.servicePort !== runtime.manifest.servicePort ||
    !validCapturePort(runtime.manifest.servicePort)
  ) {
    throw new PreviewCaptureError(
      409,
      "preview_capture_witness_changed",
      "Capture runtime witness does not match",
    );
  }
  const artifact =
    runtime.artifactKind === "layers-v1"
      ? await coordinator.getLayeredArtifact(input.runtimeIdentity, input.sealedArtifactSha256)
      : await coordinator.getArtifact(input.runtimeIdentity, input.sealedArtifactSha256);
  if (
    !artifact ||
    artifact.state !== "committed" ||
    artifact.runtimeIdentity !== input.runtimeIdentity ||
    artifact.envelope.targetRuntimeIdentity !== input.runtimeIdentity ||
    artifact.envelope.manifestRevision !== input.manifestRevision ||
    artifact.envelope.sealedArtifactSha256 !== input.sealedArtifactSha256 ||
    artifact.envelope.artifactRevision !== runtime.artifactRevision
  ) {
    throw new PreviewCaptureError(
      409,
      "preview_capture_artifact_unavailable",
      "Capture artifact is not the committed runtime artifact",
    );
  }
  return {
    runtime,
    witnessSha256: await sha256Hex(
      canonicalJson({
        manifest: runtime.manifest,
        artifactRevision: runtime.artifactRevision,
        artifactSha256: runtime.artifactSha256,
        artifactKind: runtime.artifactKind ?? "v1",
        processId: runtime.processId,
        readyAt: runtime.descriptor.readyAt,
        deploymentVersion: runtime.descriptor.deploymentVersion,
      }),
    ),
  };
}

async function assertCaptureWitness(
  claims: PreviewCaptureClaims,
  env: WorkerBindings,
  dependencies: CaptureDependencies,
): Promise<void> {
  if (claims.exp <= (dependencies.nowMs ?? Date.now())) {
    throw new PreviewCaptureError(
      401,
      "preview_capture_credential_invalid",
      "Capture credential expired",
    );
  }
  const current = await captureRuntime(claims, claims.projectId, env, dependencies.coordinator);
  if (
    current.witnessSha256 !== claims.witnessSha256 ||
    current.runtime.manifest.servicePort !== claims.port
  ) {
    throw new PreviewCaptureError(
      409,
      "preview_capture_witness_changed",
      "Capture runtime changed during rendering",
    );
  }
}

function responseHeaders(origin: string, mimeType: string): Headers {
  // External assets are intentionally omitted. No frames, workers, forms, reports or other origins.
  return new Headers({
    "content-type": mimeType,
    "cache-control": "private, no-store",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "x-dns-prefetch-control": "off",
    "cross-origin-resource-policy": "same-origin",
    "cross-origin-opener-policy": "same-origin",
    "content-security-policy": [
      "default-src 'none'",
      "script-src " + origin + " 'unsafe-inline' 'unsafe-eval'",
      "style-src " + origin + " 'unsafe-inline'",
      "img-src " + origin + " data: blob:",
      "font-src " + origin + " data:",
      "connect-src " + origin,
      "worker-src 'none'",
      "child-src 'none'",
      "frame-src 'none'",
      "object-src 'none'",
      "manifest-src 'none'",
      "media-src 'none'",
      "base-uri 'none'",
      "form-action 'none'",
      "frame-ancestors 'none'",
      "sandbox allow-scripts allow-same-origin",
    ].join("; "),
  });
}

async function proxyCaptureResource(
  request: Request,
  claims: PreviewCaptureClaims,
  env: WorkerBindings,
  dependencies: CaptureDependencies,
): Promise<Response> {
  assertCaptureRead(request);
  const url = new URL(request.url);
  const route = validateCaptureRoute(url.pathname + url.search);
  if (request.headers.get("sec-fetch-dest") === "document" && route !== claims.route) {
    throw new PreviewCaptureError(
      400,
      "preview_capture_route_unsupported",
      "Capture document navigation is restricted",
    );
  }
  await assertCaptureWitness(claims, env, dependencies);
  const headers = captureUpstreamHeaders(request.headers);
  headers.set(PREVIEW_CAPTURE_PORT_HEADER, String(claims.port));
  const upstream = await captureDeadline(
    runtimeSandboxStub(env, claims.runtimeIdentity).fetch(
      new Request(PREVIEW_CAPTURE_FORWARD_ORIGIN + route, {
        method: request.method,
        headers,
        redirect: "manual",
      }),
    ),
    PREVIEW_CAPTURE_FETCH_TIMEOUT_MS,
  );
  const mimeType = upstream.headers.get("content-type") ?? "application/octet-stream";
  const isHtml = /^text\/html(?:;|$)/iu.test(mimeType);
  if (
    upstream.status < 200 ||
    upstream.status >= 300 ||
    upstream.headers.has("location") ||
    upstream.headers.has("refresh") ||
    upstream.headers.has("upgrade") ||
    /^text\/event-stream(?:;|$)/iu.test(mimeType) ||
    (isHtml && route !== claims.route)
  ) {
    void upstream.body?.cancel().catch(() => undefined);
    throw new PreviewCaptureError(
      502,
      (upstream.status >= 300 && upstream.status < 400) ||
        upstream.headers.has("location") ||
        upstream.headers.has("refresh")
        ? "preview_capture_redirect_blocked"
        : "preview_capture_resource_failed",
      "Capture resource was unavailable or unsupported",
      true,
    );
  }
  const bytes = await readCaptureBytes(upstream, PREVIEW_CAPTURE_MAX_RESOURCE_BYTES);
  await assertCaptureWitness(claims, env, dependencies);
  return new Response(
    request.method === "HEAD" || upstream.status === 204 || upstream.status === 205
      ? null
      : bytes.slice().buffer,
    {
      status: upstream.status,
      headers: responseHeaders(claims.origin, mimeType),
    },
  );
}

async function preflightDocument(
  claims: PreviewCaptureClaims,
  env: WorkerBindings,
  dependencies: CaptureDependencies,
): Promise<void> {
  const response = await proxyCaptureResource(
    new Request(claims.origin + claims.route, {
      headers: { accept: "text/html", "sec-fetch-dest": "document" },
    }),
    claims,
    env,
    dependencies,
  );
  void response.body?.cancel().catch(() => undefined);
  if (!/^text\/html(?:;|$)/iu.test(response.headers.get("content-type") ?? "")) {
    throw new PreviewCaptureError(
      422,
      "preview_capture_document_unavailable",
      "Capture route must return successful HTML",
    );
  }
}

function assertPng(bytes: Uint8Array, viewport: PreviewCaptureInput["viewport"]): void {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (
    bytes.length < 45 ||
    !signature.every((byte, index) => bytes[index] === byte) ||
    view.getUint32(8) !== 13 ||
    Buffer.from(bytes.subarray(12, 16)).toString("ascii") !== "IHDR" ||
    view.getUint32(16) !== viewport.width ||
    view.getUint32(20) !== viewport.height ||
    Buffer.from(bytes.subarray(-12)).toString("hex") !== "0000000049454e44ae426082"
  ) {
    throw new PreviewCaptureError(
      502,
      "preview_capture_invalid_png",
      "Capture provider returned an invalid PNG or dimensions",
    );
  }
}

export async function captureProjectPreview(
  controlRequest: Request,
  projectId: number,
  value: unknown,
  env: WorkerBindings,
  dependencies: CaptureDependencies,
) {
  const input = parsePreviewCaptureInput(value);
  const origin = captureOrigin(new URL(controlRequest.url));
  if (!env.BROWSER || typeof env.BROWSER.quickAction !== "function") {
    throw new PreviewCaptureError(
      503,
      "preview_capture_browser_unavailable",
      "Capture browser binding is unavailable",
    );
  }
  const initial = await captureRuntime(input, projectId, env, dependencies.coordinator);
  const issuedAt = dependencies.nowMs ?? Date.now();
  const claims: PreviewCaptureClaims = {
    runtimeIdentity: input.runtimeIdentity,
    manifestRevision: input.manifestRevision,
    sealedArtifactSha256: input.sealedArtifactSha256,
    route: input.route,
    purpose: "nabuflow-preview-capture",
    namespace: env.CLOUDFLARE_RUNTIME_DEPLOYMENT_NAMESPACE,
    projectId,
    origin,
    port: initial.runtime.manifest.servicePort,
    witnessSha256: initial.witnessSha256,
    jti: crypto.randomUUID(),
    iat: issuedAt,
    exp: issuedAt + PREVIEW_CAPTURE_TTL_MS,
  };
  const credential = signCaptureCredential(env.CLOUDFLARE_RUNTIME_CONTROL_TOKEN, claims);
  try {
    await preflightDocument(claims, env, dependencies);
    const escapedOrigin = origin.replace(/[.*+?^$(){}|[\]\\]/gu, "\\$&");
    const options: BrowserRunScreenshotOptions = {
      url: origin + input.route,
      cacheTTL: 0,
      cookies: [],
      bestAttempt: false,
      allowRequestPattern: ["^" + escapedOrigin + "/[^\\s]*$"],
      rejectResourceTypes: [
        "websocket",
        "eventsource",
        "ping",
        "cspviolationreport",
        "prefetch",
        "preflight",
        "manifest",
        "signedexchange",
        "media",
        "texttrack",
        "other",
      ],
      setExtraHTTPHeaders: { [PREVIEW_CAPTURE_HEADER]: credential },
      viewport: { ...input.viewport, deviceScaleFactor: 1 },
      screenshotOptions: {
        type: "png",
        encoding: "binary",
        fullPage: false,
        captureBeyondViewport: false,
      },
      gotoOptions: { timeout: 18_000, waitUntil: "networkidle0" },
      actionTimeout: 5_000,
      waitForTimeout: 250,
    };
    const browser = env.BROWSER;
    const bytes = await captureDeadline(
      (async () => {
        const response = await browser.quickAction("screenshot", options);
        if (
          !response.ok ||
          response.status !== 200 ||
          response.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "image/png"
        ) {
          void response.body?.cancel().catch(() => undefined);
          throw new PreviewCaptureError(
            502,
            "preview_capture_provider_failed",
            "Capture browser failed to return PNG",
            true,
          );
        }
        return readCaptureBytes(response, PREVIEW_CAPTURE_MAX_PNG_BYTES);
      })(),
      PREVIEW_CAPTURE_PROVIDER_TIMEOUT_MS,
    );
    assertPng(bytes, input.viewport);
    await preflightDocument(claims, env, dependencies);
    await assertCaptureWitness(claims, env, dependencies);
    const nowMs = dependencies.nowMs ?? Date.now();
    if (
      !(await dependencies.coordinator.isConsumedOnce(captureMarker(claims, "document"), nowMs)) ||
      (await dependencies.coordinator.isConsumedOnce(captureMarker(claims, "failed"), nowMs))
    ) {
      throw new PreviewCaptureError(
        502,
        "preview_capture_render_failed",
        "Capture did not complete an authenticated document render",
        true,
      );
    }
    return {
      ok: true as const,
      capture: {
        mimeType: "image/png" as const,
        base64: Buffer.from(bytes).toString("base64"),
        sha256: await sha256Hex(bytes),
        width: input.viewport.width,
        height: input.viewport.height,
        route: input.route,
        runtimeIdentity: input.runtimeIdentity,
        manifestRevision: input.manifestRevision,
        sealedArtifactSha256: input.sealedArtifactSha256,
      },
    };
  } catch (error) {
    if (error instanceof PreviewCaptureError) throw error;
    throw new PreviewCaptureError(
      503,
      "preview_capture_provider_failed",
      "Capture could not complete",
      true,
    );
  } finally {
    // Nonce markers contain only a random identifier and expiry, never image bytes or credentials.
    // Closing also fences a provider action that outlives our bounded wait.
    await dependencies.coordinator.consumeOnce(captureMarker(claims, "closed"), claims.exp);
  }
}

export async function handlePreviewCaptureDataPlaneRequest(
  request: Request,
  env: WorkerBindings,
  dependencies: CaptureDependencies,
): Promise<Response | null> {
  if (!request.headers.has(PREVIEW_CAPTURE_HEADER)) return null;
  let claims: PreviewCaptureClaims | undefined;
  try {
    const origin = captureOrigin(new URL(request.url));
    claims = verifyCaptureCredential(
      env.CLOUDFLARE_RUNTIME_CONTROL_TOKEN,
      request.headers.get(PREVIEW_CAPTURE_HEADER) ?? "",
      origin,
      env.CLOUDFLARE_RUNTIME_DEPLOYMENT_NAMESPACE,
      dependencies.nowMs ?? Date.now(),
    );
    if (
      await dependencies.coordinator.isConsumedOnce(
        captureMarker(claims, "closed"),
        dependencies.nowMs ?? Date.now(),
      )
    ) {
      throw new PreviewCaptureError(401, "preview_capture_closed", "Capture credential is closed");
    }
    const response = await proxyCaptureResource(request, claims, env, dependencies);
    if (request.method === "GET" && request.headers.get("sec-fetch-dest") === "document") {
      if (!/^text\/html(?:;|$)/iu.test(response.headers.get("content-type") ?? "")) {
        throw new PreviewCaptureError(
          422,
          "preview_capture_document_unavailable",
          "Capture document must be HTML",
        );
      }
      await dependencies.coordinator.consumeOnce(captureMarker(claims, "document"), claims.exp);
    }
    return response;
  } catch (error) {
    const failure =
      error instanceof PreviewCaptureError
        ? error
        : new PreviewCaptureError(
            503,
            "preview_capture_resource_failed",
            "Capture resource could not be served",
            true,
          );
    if (claims && failure.code !== "preview_capture_closed") {
      await dependencies.coordinator.consumeOnce(captureMarker(claims, "failed"), claims.exp);
    }
    return Response.json(
      controlErrorResponseSchema.parse({
        ok: false,
        code: failure.code,
        message: failure.message,
        retryable: failure.retryable,
        requestId: dependencies.requestId ?? crypto.randomUUID(),
      }),
      {
        status: failure.status,
        headers: {
          "cache-control": "no-store",
          "content-security-policy": "default-src 'none'",
          "x-content-type-options": "nosniff",
        },
      },
    );
  }
}
