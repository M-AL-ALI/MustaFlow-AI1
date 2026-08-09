import { describe, expect, it } from "vitest";
import {
  CAPABILITY_INTENT_URL,
  DATABASE_BATCH_MAX_STATEMENTS,
  DATABASE_CAPABILITY_ACTION,
  DATABASE_OPERATION_DEFAULT_TIMEOUT_MS,
  DATABASE_OPERATION_MAX_TIMEOUT_MS,
  TENANT_RUNTIME_MODE_ENV,
  capabilityIntentSchema,
  makeRuntimeDatabaseCapabilityIntent,
  mapCapabilityDatabaseError,
  runtimeDatabaseCapabilityIntentSchema,
  serializeRuntimeDatabaseCapabilityIntent,
  tenantRuntimeModeSchema,
} from "../src";

const statement = {
  kind: "statement" as const,
  sql: "select $1::text as value",
  params: ["hello"],
};

describe("dual-mode runtime SDK contract", () => {
  it("defines explicit fail-closed modes and the existing virtual doorman route", () => {
    expect(TENANT_RUNTIME_MODE_ENV).toBe("NABUFLOW_RUNTIME_MODE");
    expect(tenantRuntimeModeSchema.parse("fly-direct-v1")).toBe("fly-direct-v1");
    expect(tenantRuntimeModeSchema.parse("cloudflare-capability-v1")).toBe(
      "cloudflare-capability-v1",
    );
    expect(tenantRuntimeModeSchema.safeParse("auto").success).toBe(false);
    expect(CAPABILITY_INTENT_URL).toBe("http://doorman.staging.nabuflow.internal/v1/invoke");
  });

  it("constructs byte-stable intents accepted by the shipped capability contract", () => {
    const requestId = "sdk-compatibility-request-0001";
    const intent = makeRuntimeDatabaseCapabilityIntent({ requestId, operation: statement });
    expect(runtimeDatabaseCapabilityIntentSchema.parse(intent)).toEqual(intent);
    expect(capabilityIntentSchema.parse(intent)).toEqual(intent);
    expect(serializeRuntimeDatabaseCapabilityIntent({ requestId, operation: statement })).toBe(
      '{"v":1,"capability":{"provider":"neon-postgres","name":"database"},"action":"query","requestId":"sdk-compatibility-request-0001","input":{"sql":"select $1::text as value","params":["hello"],"kind":"statement"}}',
    );
    expect(intent.action).toBe(DATABASE_CAPABILITY_ACTION);
    expect(JSON.stringify(intent)).not.toMatch(
      /requestedProjectId|runtimeIdentity|containerId|credential|secret|vault|signature/iu,
    );
  });

  it("keeps database bounds centralized for vendored and broker consumers", () => {
    expect(DATABASE_BATCH_MAX_STATEMENTS).toBe(20);
    expect(DATABASE_OPERATION_DEFAULT_TIMEOUT_MS).toBe(10_000);
    expect(DATABASE_OPERATION_MAX_TIMEOUT_MS).toBe(30_000);
  });

  it.each([
    ["database_invalid_query", 400, "invalid_query"],
    ["database_constraint_violation", 409, "conflict"],
    ["database_conflict", 409, "conflict"],
    ["database_timeout", 504, "timeout"],
    ["capability_policy_rejected", 403, "policy_rejected"],
    ["database_response_too_large", 502, "policy_rejected"],
    ["database_unavailable", 503, "unavailable"],
    ["capability_runtime_unbound", 403, "unavailable"],
    ["unknown_provider_detail", 500, "internal"],
  ] as const)("maps %s at %i to the stable %s category", (providerCode, status, expected) => {
    expect(mapCapabilityDatabaseError(providerCode, status)).toBe(expected);
  });

  it("rejects cross-tenant authority and non-scalar parameters", () => {
    expect(
      runtimeDatabaseCapabilityIntentSchema.safeParse({
        ...makeRuntimeDatabaseCapabilityIntent({
          requestId: "sdk-authority-request-0001",
          operation: statement,
        }),
        requestedProjectId: 43,
      }).success,
    ).toBe(false);
    expect(
      runtimeDatabaseCapabilityIntentSchema.safeParse({
        ...makeRuntimeDatabaseCapabilityIntent({
          requestId: "sdk-authority-request-0002",
          operation: statement,
        }),
        input: { kind: "statement", sql: "select $1", params: [{ projectId: 43 }] },
      }).success,
    ).toBe(false);
  });
});
