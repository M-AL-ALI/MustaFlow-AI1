import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CONTROL_API_PREFIX,
  deriveRuntimeIdentity,
  signControlRequest,
  sha256Hex,
} from "@workspace/tenant-runtime-contracts";
import { CloudflareRuntimeProvider } from "./cloudflare-runtime-provider";
import {
  supportsProjectPreviewCapture,
  type ProjectPreviewCaptureInput,
} from "./tenant-runtime-provider";

const token = "preview-test-control-token-at-least-thirty-two-characters";
const config = {
  controlUrl: "https://runtime.example.test",
  controlToken: token,
  deploymentNamespace: "staging",
};
const options = { idempotencyKey: "capture_1234567890abcdef", timeoutMs: 45_000 };
const fetchMock = vi.fn<typeof fetch>();
async function input(): Promise<ProjectPreviewCaptureInput> {
  return {
    projectId: 81,
    runtimeIdentity: await deriveRuntimeIdentity({
      namespace: "staging",
      projectId: 81,
      role: "preview",
      slot: "primary",
    }),
    manifestRevision: "manifest-1",
    sealedArtifactSha256: "b".repeat(64),
    route: "/",
    viewport: { width: 1280, height: 800 },
  };
}
beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe("dedicated project preview provider transport", () => {
  it("signs exactly one project-scoped request without a start or descriptor request", async () => {
    const provider = new CloudflareRuntimeProvider(config);
    const payload = await input();
    const response = { ok: true, capture: { base64: "fixture-not-render-proof" } };
    fetchMock.mockResolvedValue(new Response(JSON.stringify(response), { status: 200 }));
    const signal = new AbortController().signal;
    expect(supportsProjectPreviewCapture(provider)).toBe(true);
    expect(await provider.captureProjectPreview(payload, { ...options, signal })).toEqual(response);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    const parsed = new URL(String(url));
    expect(parsed.href).toBe(
      config.controlUrl + CONTROL_API_PREFIX + "/projects/81/preview-capture",
    );
    expect(init?.method).toBe("POST");
    const headers = new Headers(init?.headers);
    expect(headers.get("idempotency-key")).toBe(options.idempotencyKey);
    expect(JSON.parse(init!.body as string)).toEqual({
      runtimeIdentity: payload.runtimeIdentity,
      manifestRevision: payload.manifestRevision,
      sealedArtifactSha256: payload.sealedArtifactSha256,
      route: "/",
      viewport: { width: 1280, height: 800 },
    });
    expect(
      await signControlRequest(token, {
        method: "POST",
        pathAndQuery: parsed.pathname,
        timestamp: headers.get("x-nabuflow-timestamp")!,
        nonce: headers.get("x-nabuflow-nonce")!,
        bodySha256: await sha256Hex(init!.body as string),
        idempotencyKey: options.idempotencyKey,
      }),
    ).toBe(headers.get("x-nabuflow-signature"));
  });
  it("does not broaden the Zero-generation transport allowlist", async () => {
    const provider = new CloudflareRuntimeProvider(config);
    await expect(
      provider.zeroGenerationControlRequest({
        method: "POST",
        path: CONTROL_API_PREFIX + "/projects/81/preview-capture",
      }),
    ).rejects.toMatchObject({ code: "invalid_zero_generation_control_path" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("does not replay an ambiguous paid render", async () => {
    fetchMock.mockRejectedValue(new TypeError("connection lost"));
    await expect(
      new CloudflareRuntimeProvider(config).captureProjectPreview(await input(), options),
    ).rejects.toMatchObject({ code: "control_transport_fetch_exception" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it("does not replay a retryable provider failure", async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          code: "busy",
          message: "busy",
          retryable: true,
        }),
        { status: 503 },
      ),
    );
    await expect(
      new CloudflareRuntimeProvider(config).captureProjectPreview(await input(), options),
    ).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it.each(["other-project", "other-namespace", "production"] as const)(
    "rejects %s before I/O",
    async (kind) => {
      const payload = await input();
      payload.runtimeIdentity = await deriveRuntimeIdentity({
        namespace: kind === "other-namespace" ? "production" : "staging",
        projectId: kind === "other-project" ? 82 : 81,
        role: kind === "production" ? "production" : "preview",
        slot: kind === "production" ? "blue" : "primary",
      });
      await expect(
        new CloudflareRuntimeProvider(config).captureProjectPreview(payload, options),
      ).rejects.toThrow();
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );
  it.each([0, -1, 1.5, 2147483648])("rejects invalid project %s", async (projectId) => {
    const payload = { ...(await input()), projectId };
    await expect(
      new CloudflareRuntimeProvider(config).captureProjectPreview(payload, options),
    ).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("rejects a non-root route even if a caller bypasses the literal type", async () => {
    const payload = {
      ...(await input()),
      route: "/control",
    } as unknown as ProjectPreviewCaptureInput;
    await expect(
      new CloudflareRuntimeProvider(config).captureProjectPreview(payload, options),
    ).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("does not dispatch an already cancelled capture", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      new CloudflareRuntimeProvider(config).captureProjectPreview(await input(), {
        ...options,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: "control_operation_cancelled" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
