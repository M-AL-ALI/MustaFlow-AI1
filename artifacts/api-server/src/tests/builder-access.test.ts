import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { hasBuilderAccess, isBuilderOpenToAll, parseBuilderAllowlist } from "../lib/builder-access";

describe("AI Builder cohort access", () => {
  it("parses comma-separated emails case-insensitively and trims whitespace", () => {
    expect([
      ...parseBuilderAllowlist(" Owner@Example.com, tester@example.com , ,OWNER@example.com"),
    ]).toEqual(["owner@example.com", "tester@example.com"]);
  });

  it("allows only matching emails when the launch override is off", () => {
    const options = {
      allowlist: " owner@example.com ",
      openToAll: "false",
    };
    expect(hasBuilderAccess("OWNER@EXAMPLE.COM", options)).toBe(true);
    expect(hasBuilderAccess("other@example.com", options)).toBe(false);
    expect(hasBuilderAccess(null, options)).toBe(false);
  });

  it("allows every authenticated user when BUILDER_OPEN_TO_ALL is true", () => {
    expect(isBuilderOpenToAll(" TRUE ")).toBe(true);
    expect(hasBuilderAccess(null, { allowlist: "", openToAll: "true" })).toBe(true);
  });

  it("returns access and live-server capability fields from preferences", () => {
    const routePath = fileURLToPath(new URL("../routes/preferences.ts", import.meta.url));
    const route = readFileSync(routePath, "utf8");
    expect(route).toContain("builderAccess");
    expect(route).toContain("containerLayerConfigured");
    expect(route).toContain("await isContainerLayerConfigured()");
    expect(route).toContain("...capabilities");
  });

  it("surfaces the partial-validation completion message in the live Builder report", () => {
    const workspacePath = fileURLToPath(
      new URL("../../../mustaflow/src/pages/projects/[id].tsx", import.meta.url),
    );
    const workspace = readFileSync(workspacePath, "utf8");
    expect(workspace).toContain("partialValidationMessage");
    expect(workspace).toContain('warning.toLowerCase().includes("validation was partial")');
    expect(workspace).toContain(
      "Build completed with partial validation — live-server infrastructure was",
    );
    expect(workspace).toContain("container-dependent checks were deferred.");
  });
});
