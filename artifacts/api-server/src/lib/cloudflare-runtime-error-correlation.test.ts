import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CONTROL_PROTOCOL_VERSION,
  deriveRuntimeIdentity,
} from "@workspace/tenant-runtime-contracts";
import {
  CloudflareRuntimeControlError,
  CloudflareRuntimeProvider,
} from "./cloudflare-runtime-provider";

const config = {
  controlUrl: "https://runtime.example.test",
  controlToken: "test-only-control-token-at-least-thirty-two-characters",
  deploymentNamespace: "staging",
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("runtime control error correlation", () => {
  it.each([
    { status: 500, code: "internal_error" },
    { status: 503, code: "runtime_stop_process_cleanup_failed" },
    { status: 503, code: "runtime_stop_container_failed" },
  ])("retains the request ID for $code without repeating the stop", async ({ status, code }) => {
    const identity = await deriveRuntimeIdentity({
      namespace: "staging",
      projectId: 61,
      role: "preview",
      slot: "primary",
    });
    let stopCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: Parameters<typeof fetch>[0]) => {
        if (new URL(String(input)).pathname.endsWith("/version")) {
          return Response.json({
            protocolVersion: CONTROL_PROTOCOL_VERSION,
            deploymentVersion: "staging-v1",
            provider: "cloudflare",
            supportedRoles: ["preview", "production"],
            features: [],
          });
        }
        expect(new URL(String(input)).pathname).toBe(
          "/_nabuflow/control/v1/runtimes/61/preview/primary/stop",
        );
        stopCalls += 1;
        return Response.json(
          {
            ok: false,
            code,
            message: "Runtime stop did not complete",
            retryable: true,
            requestId: "server-request-190",
          },
          { status },
        );
      }),
    );

    await expect(new CloudflareRuntimeProvider(config).stop(identity, 61)).rejects.toMatchObject({
      name: "CloudflareRuntimeControlError",
      status,
      code,
      retryable: true,
      transportCause: null,
      requestId: "server-request-190",
    });
    expect(stopCalls).toBe(1);
  });

  it("does not invent a server request ID for local failures", () => {
    const error = new CloudflareRuntimeControlError(503, "transport_error", true, "Unavailable");
    expect(error.requestId).toBeNull();
  });

  it("does not trust request IDs from malformed provider error bodies", async () => {
    const identity = await deriveRuntimeIdentity({
      namespace: "staging",
      projectId: 61,
      role: "preview",
      slot: "primary",
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: Parameters<typeof fetch>[0]) => {
        if (new URL(String(input)).pathname.endsWith("/version")) {
          return Response.json({
            protocolVersion: CONTROL_PROTOCOL_VERSION,
            deploymentVersion: "staging-v1",
            provider: "cloudflare",
            supportedRoles: ["preview", "production"],
            features: [],
          });
        }
        return Response.json({ requestId: "not-a-valid-control-error" }, { status: 500 });
      }),
    );

    await expect(new CloudflareRuntimeProvider(config).stop(identity, 61)).rejects.toMatchObject({
      code: "unexpected_control_5xx",
      requestId: null,
    });
  });
});
