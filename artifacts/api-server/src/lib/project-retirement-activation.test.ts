import { describe, expect, it } from "vitest";
import {
  EDGE_SERVING_FLAG,
  isProjectRetirementExecutionEnabled,
  PROJECT_RETIREMENT_EXECUTION_FLAG,
  resolveCurrentCloudflareRetirementPosture,
  resolveLegacyHostnameKvPosture,
} from "./project-retirement-activation";

describe("project retirement activation", () => {
  it("fails closed when the rollout flag is absent or imprecise", () => {
    expect(isProjectRetirementExecutionEnabled({})).toBe(false);
    expect(
      isProjectRetirementExecutionEnabled({ [PROJECT_RETIREMENT_EXECUTION_FLAG]: "false" }),
    ).toBe(false);
    expect(isProjectRetirementExecutionEnabled({ [PROJECT_RETIREMENT_EXECUTION_FLAG]: "1" })).toBe(
      false,
    );
    expect(
      isProjectRetirementExecutionEnabled({ [PROJECT_RETIREMENT_EXECUTION_FLAG]: "TRUE" }),
    ).toBe(false);
  });

  it("enables provider cleanup only for the exact governed value", () => {
    expect(
      isProjectRetirementExecutionEnabled({ [PROJECT_RETIREMENT_EXECUTION_FLAG]: "true" }),
    ).toBe(true);
    expect(resolveLegacyHostnameKvPosture({ [PROJECT_RETIREMENT_EXECUTION_FLAG]: "true" })).toEqual(
      { state: "not_configured", missingBindings: [], invalidInputs: [] },
    );
  });

  it("treats the absent retired Snapshot-Worker KV subsystem as not configured", () => {
    expect(
      resolveLegacyHostnameKvPosture({
        [PROJECT_RETIREMENT_EXECUTION_FLAG]: "true",
        CF_ACCOUNT_ID: "shared-r2-account",
        CF_API_TOKEN: "shared-cloudflare-token",
        CF_ZONE_ID: "shared-zone",
      }),
    ).toEqual({ state: "not_configured", missingBindings: [], invalidInputs: [] });
  });

  it("classifies current cache-purge bindings without exposing their values", () => {
    expect(resolveCurrentCloudflareRetirementPosture({})).toEqual({
      state: "blocked",
      missingBindings: ["CF_ZONE_ID", "CF_API_TOKEN"],
    });
    expect(resolveCurrentCloudflareRetirementPosture({ CF_ZONE_ID: "zone" })).toEqual({
      state: "blocked",
      missingBindings: ["CF_API_TOKEN"],
    });
    expect(
      resolveCurrentCloudflareRetirementPosture({
        CF_ZONE_ID: "zone-secret",
        CF_API_TOKEN: "token-secret",
      }),
    ).toEqual({ state: "configured", missingBindings: [] });
    expect(
      JSON.stringify(
        resolveCurrentCloudflareRetirementPosture({
          CF_ZONE_ID: "zone-secret",
          CF_API_TOKEN: "token-secret",
        }),
      ),
    ).not.toMatch(/zone-secret|token-secret/u);
  });

  it("fails closed when legacy edge routing is required but KV is incomplete", () => {
    const environment = {
      [PROJECT_RETIREMENT_EXECUTION_FLAG]: "true",
      [EDGE_SERVING_FLAG]: "true",
      CF_ACCOUNT_ID: "account",
      CF_API_TOKEN: "token",
      CF_ZONE_ID: "zone",
    };
    expect(resolveLegacyHostnameKvPosture(environment)).toEqual({
      state: "blocked",
      missingBindings: ["CF_KV_NAMESPACE_ID"],
      invalidInputs: [],
    });
    expect(isProjectRetirementExecutionEnabled(environment)).toBe(false);
  });

  it("fails closed on an imprecise edge-routing value", () => {
    const environment = {
      [PROJECT_RETIREMENT_EXECUTION_FLAG]: "true",
      [EDGE_SERVING_FLAG]: "TRUE",
    };
    expect(resolveLegacyHostnameKvPosture(environment)).toEqual({
      state: "blocked",
      missingBindings: [],
      invalidInputs: [EDGE_SERVING_FLAG],
    });
    expect(isProjectRetirementExecutionEnabled(environment)).toBe(false);
  });

  it("enables strict legacy KV inventory only with its complete binding set", () => {
    const environment = {
      [PROJECT_RETIREMENT_EXECUTION_FLAG]: "true",
      CF_ACCOUNT_ID: "account",
      CF_API_TOKEN: "token",
      CF_KV_NAMESPACE_ID: "namespace",
      CF_ZONE_ID: "zone",
    };
    expect(resolveLegacyHostnameKvPosture(environment)).toEqual({
      state: "configured",
      missingBindings: [],
      invalidInputs: [],
    });
    expect(isProjectRetirementExecutionEnabled(environment)).toBe(true);
  });
});
