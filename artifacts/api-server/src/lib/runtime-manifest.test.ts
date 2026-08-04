import { describe, expect, it } from "vitest";
import { CHECK_PROFILES, checkProfileForServicePort } from "./check-profiles";
import {
  LEGACY_FASTAPI_SERVICE_PORT,
  LEGACY_FLASK_SERVICE_PORT,
  LEGACY_NODE_SERVICE_PORT,
  resolveProjectRuntimeManifest,
} from "./runtime-manifest";

describe("project runtime service port", () => {
  it("preserves every historical default when a project has no explicit port", () => {
    expect(
      resolveProjectRuntimeManifest({ stack: "node-api", legacyProfile: "stack" }).servicePort,
    ).toBe(LEGACY_NODE_SERVICE_PORT);
    expect(
      resolveProjectRuntimeManifest({ stack: "python-flask", legacyProfile: "stack" }).servicePort,
    ).toBe(LEGACY_FLASK_SERVICE_PORT);
    expect(
      resolveProjectRuntimeManifest({ stack: "python-fastapi", legacyProfile: "stack" })
        .servicePort,
    ).toBe(LEGACY_FASTAPI_SERVICE_PORT);
    expect(
      resolveProjectRuntimeManifest({ stack: "python-fastapi", legacyProfile: "fixed-node" })
        .servicePort,
    ).toBe(LEGACY_NODE_SERVICE_PORT);
  });

  it("uses an explicit project port across legacy profiles", () => {
    expect(
      resolveProjectRuntimeManifest({
        runtimePort: 4321,
        stack: "python-fastapi",
        legacyProfile: "stack",
      }),
    ).toEqual({ servicePort: 4321, servicePortSource: "project" });
    expect(
      resolveProjectRuntimeManifest({
        runtimePort: 4321,
        stack: "node-api",
        legacyProfile: "fixed-node",
      }).servicePort,
    ).toBe(4321);
  });

  it("materializes server checks with the explicit service port", () => {
    const profile = checkProfileForServicePort(CHECK_PROFILES["node-api"], 4321);
    const serverStart = profile.checks.find((check) => check.id === "server-start");
    expect(serverStart?.argv.join("\n")).toContain("localhost:4321/healthz");
    expect(serverStart?.argv.join("\n")).toContain("export PORT=4321");
    expect(serverStart?.argv.join("\n")).not.toContain("__NABUFLOW_SERVICE_PORT__");
  });
});
