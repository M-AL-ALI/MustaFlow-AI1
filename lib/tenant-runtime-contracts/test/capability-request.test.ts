import { describe, expect, it } from "vitest";
import {
  capabilityBindingResponseSchema,
  capabilityEchoResponseSchema,
  capabilityIntentSchema,
  capabilityInvocationSchema,
  provisionEchoCapabilityRequestSchema,
} from "../src/capability-request";

const definition = {
  name: "echo",
  provider: "nabuflow-harness",
  allowedMethods: ["POST"],
  allowedPaths: [{ match: "exact", path: "/v1/echo" }],
  injection: { location: "worker-binding" },
  limits: {
    timeoutMs: 5_000,
    maxRequestBytes: 32_768,
    maxResponseBytes: 32_768,
    maxRequestsPerMinute: 60,
    maxConcurrent: 4,
  },
} as const;

const intent = {
  v: 1,
  capability: { provider: "nabuflow-harness", name: "echo" },
  action: "invoke",
  requestId: "capability-request-0001",
  input: { message: "hello" },
} as const;

describe("capability request contract", () => {
  it("accepts a bounded tenant intent without identity or credential authority", () => {
    expect(capabilityIntentSchema.parse(intent)).toEqual(intent);
    expect(JSON.stringify(intent)).not.toMatch(/credential|secret|runtimeIdentity|containerId/);
  });

  it("requires the trusted invocation to bind container and runtime identity", () => {
    expect(
      capabilityInvocationSchema.parse({
        ...intent,
        caller: {
          containerId: "0123456789abcdef0123456789abcdef",
          runtimeIdentity: "nrf-aaaaaaaaaaaaaaaa-p42-preview-primary",
        },
      }),
    ).toMatchObject({ caller: { runtimeIdentity: expect.stringContaining("nrf-") } });
  });

  it("rejects unknown fields and oversized input", () => {
    expect(
      capabilityIntentSchema.safeParse({ ...intent, credential: "must-not-pass" }).success,
    ).toBe(false);
    expect(
      capabilityIntentSchema.safeParse({ ...intent, input: { value: "x".repeat(33 * 1024) } })
        .success,
    ).toBe(false);
  });

  it("uses the shipped capability policy for echo provisioning", () => {
    expect(
      provisionEchoCapabilityRequestSchema.parse({
        projectId: 42,
        revision: "echo-v1",
        definition,
      }),
    ).toMatchObject({ definition: { injection: { location: "worker-binding" } } });
  });

  it("keeps the benign response proof credential-free", () => {
    const response = capabilityEchoResponseSchema.parse({
      ok: true,
      capability: intent.capability,
      requestId: intent.requestId,
      runtimeIdentity: "nrf-aaaaaaaaaaaaaaaa-p42-preview-primary",
      actedBy: "capability-vault",
      proof: "a".repeat(64),
      echo: intent.input,
    });
    expect(JSON.stringify(response)).not.toMatch(/credential|secret|ciphertext|keyId/i);
  });

  it("keeps platform binding diagnostics control-only and minimal", () => {
    expect(
      capabilityBindingResponseSchema.parse({
        runtimeIdentity: "nrf-aaaaaaaaaaaaaaaa-p42-preview-primary",
        active: true,
        containerId: "0123456789abcdef0123456789abcdef",
      }),
    ).toEqual({
      runtimeIdentity: "nrf-aaaaaaaaaaaaaaaa-p42-preview-primary",
      active: true,
      containerId: "0123456789abcdef0123456789abcdef",
    });
  });
});
