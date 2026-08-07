import { describe, expect, it } from "vitest";
import {
  capabilityBindingResponseSchema,
  capabilityEchoResponseSchema,
  capabilityDatabaseResponseSchema,
  databaseCapabilityInputSchema,
  capabilityIntentSchema,
  capabilityInvocationSchema,
  provisionEchoCapabilityRequestSchema,
  provisionDatabaseCapabilityRequestSchema,
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

  it("defines bounded parameterized statements and atomic batches", () => {
    expect(
      databaseCapabilityInputSchema.parse({
        kind: "statement",
        sql: "select $1::text as value",
        params: ["hello"],
      }),
    ).toMatchObject({ kind: "statement", params: ["hello"] });
    expect(
      databaseCapabilityInputSchema.parse({
        kind: "atomic-batch",
        statements: [
          { sql: "insert into items(value) values ($1)", params: ["one"] },
          { sql: "select count(*) from items", params: [] },
        ],
      }),
    ).toMatchObject({ kind: "atomic-batch", statements: expect.any(Array) });
    expect(
      databaseCapabilityInputSchema.safeParse({
        kind: "statement",
        sql: "select $1",
        params: [{ credential: "not-a-scalar" }],
      }).success,
    ).toBe(false);
  });

  it("keeps database credentials control-only and results sanitized", () => {
    const databaseDefinition = {
      ...definition,
      name: "database",
      provider: "neon-postgres",
      allowedPaths: [{ match: "exact", path: "/v1/query" }],
    } as const;
    expect(
      provisionDatabaseCapabilityRequestSchema.parse({
        projectId: 42,
        revision: "database-v1",
        definition: databaseDefinition,
        credential: {
          kind: "neon-connection-string",
          value: "postgresql://user:password@ep-test.us-east-2.aws.neon.tech/db",
        },
      }),
    ).toMatchObject({ credential: { kind: "neon-connection-string" } });
    const response = capabilityDatabaseResponseSchema.parse({
      ok: true,
      capability: { provider: "neon-postgres", name: "database" },
      requestId: "database-request-0001",
      runtimeIdentity: "nrf-aaaaaaaaaaaaaaaa-p42-production-blue",
      actedBy: "database-broker",
      result: {
        kind: "statement",
        result: { command: "SELECT", rowCount: 1, rows: [{ value: "hello" }] },
      },
    });
    expect(JSON.stringify(response)).not.toMatch(/password|hostname|connection|credential/i);
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
