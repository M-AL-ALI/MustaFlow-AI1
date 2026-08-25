import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  BUILDER_ACCESS_DENIED_MESSAGE,
  createBuilderAccessMiddleware,
  hasBuilderAccess,
  isBuilderOpenToAll,
  parseBuilderAllowlist,
  type BuilderEmailLookup,
} from "../lib/builder-access";

function createMiddlewareApp(lookupEmail: BuilderEmailLookup) {
  const app = express();
  app.use((req, _res, next) => {
    req.userId = "user_test";
    next();
  });
  app.post("/builder-mutation", createBuilderAccessMiddleware(lookupEmail), (_req, res) => {
    res.json({ ok: true });
  });
  return app;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("AI Builder cohort access", () => {
  it("parses comma-separated emails case-insensitively and trims whitespace", () => {
    expect([
      ...parseBuilderAllowlist(" Owner@Example.com, tester@example.com , ,OWNER@example.com"),
    ]).toEqual(["owner@example.com", "tester@example.com"]);
  });

  it("keeps the production Builder cohort limited to the two approved accounts", () => {
    const configPath = fileURLToPath(new URL("../../../../.replit", import.meta.url));
    const config = readFileSync(configPath, "utf8");
    const productionSection = config.match(
      /\[userenv\.production\]([\s\S]*?)(?=\n\[[^\]]+\]|$)/,
    )?.[1];

    expect(productionSection).toBeDefined();
    const configuredAllowlist = productionSection?.match(
      /^BUILDER_ALLOWLIST\s*=\s*"([^"]*)"$/m,
    )?.[1];
    expect([...parseBuilderAllowlist(configuredAllowlist)]).toEqual([
      "mus_192@yahoo.com",
      "alialmshhdany0@gmail.com",
    ]);
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

  it("lets an allowlisted email reach a Builder mutation", async () => {
    vi.stubEnv("BUILDER_OPEN_TO_ALL", "false");
    vi.stubEnv("BUILDER_ALLOWLIST", "allowed@example.com");
    const lookupEmail = vi.fn<BuilderEmailLookup>().mockResolvedValue("ALLOWED@example.com");

    const response = await request(createMiddlewareApp(lookupEmail)).post("/builder-mutation");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true });
    expect(lookupEmail).toHaveBeenCalledWith("user_test");
  });

  it("returns a clean 403 for a non-allowlisted email", async () => {
    vi.stubEnv("BUILDER_OPEN_TO_ALL", "false");
    vi.stubEnv("BUILDER_ALLOWLIST", "allowed@example.com");

    const response = await request(createMiddlewareApp(async () => "other@example.com")).post(
      "/builder-mutation",
    );

    expect(response.status).toBe(403);
    expect(response.body).toEqual({ error: BUILDER_ACCESS_DENIED_MESSAGE });
  });

  it("fails closed when Clerk cannot provide an email", async () => {
    vi.stubEnv("BUILDER_OPEN_TO_ALL", "false");
    vi.stubEnv("BUILDER_ALLOWLIST", "allowed@example.com");

    const response = await request(createMiddlewareApp(async () => null)).post("/builder-mutation");

    expect(response.status).toBe(403);
    expect(response.body).toEqual({ error: BUILDER_ACCESS_DENIED_MESSAGE });
  });

  it("lets everyone through without an email lookup when BUILDER_OPEN_TO_ALL=true", async () => {
    vi.stubEnv("BUILDER_OPEN_TO_ALL", "true");
    vi.stubEnv("BUILDER_ALLOWLIST", "");
    const lookupEmail = vi.fn<BuilderEmailLookup>().mockResolvedValue(null);

    const response = await request(createMiddlewareApp(lookupEmail)).post("/builder-mutation");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true });
    expect(lookupEmail).not.toHaveBeenCalled();
  });

  it("gates Builder mutations while leaving public brainstorm chat unchanged", () => {
    const routePath = fileURLToPath(new URL("../routes/index.ts", import.meta.url));
    const routes = readFileSync(routePath, "utf8");
    const guardedRoutes = [
      ["post", "/projects"],
      ["post", "/projects/:id/messages"],
      ["post", "/projects/:id/messages/stream"],
      ["post", "/projects/:id/plans/decompose"],
      ["post", "/projects/:id/plans/clarify"],
      ["post", "/projects/:id/queue"],
      ["post", "/projects/:id/queue/resume-paused"],
      ["delete", "/projects/:id/queue/:batchId"],
      ["post", "/projects/:id/restore"],
      ["post", "/projects/:id/checkpoints/:checkpointId/restore"],
      ["post", "/projects/:id/versions/:versionId/rollback"],
    ] as const;

    for (const [method, path] of guardedRoutes) {
      expect(routes).toContain(`router.${method}("${path}", requireBuilderAccess);`);
    }
    expect(routes).toMatch(
      /router\.post\(\s*"\/brainstorm\/resolve",\s*attachUser,\s*requireBuilderAccess,\s*brainstormAdmissionLimiter,\s*aiBuilderLimiter,?\s*\);/,
    );
    expect(routes).toMatch(
      /router\.post\(\s*"\/brainstorm\/chat",\s*attachOptionalClerkUser,\s*brainstormAdmissionLimiter,\s*aiBuilderLimiter,?\s*\);/,
    );
    expect(routes.match(/"\/brainstorm\/chat"/g)).toHaveLength(1);
    expect(routes.match(/"\/brainstorm\/resolve"/g)).toHaveLength(1);
  });

  it("returns access and live-server capability fields from preferences", () => {
    const routePath = fileURLToPath(new URL("../routes/preferences.ts", import.meta.url));
    const route = readFileSync(routePath, "utf8");
    expect(route).toContain("builderAccess");
    expect(route).toContain("containerLayerConfigured");
    expect(route).toContain("await isContainerLayerConfigured()");
    expect(route).toContain("...capabilities");
  });

  it("surfaces the partial-validation completion message in the inline build results", () => {
    const workspacePath = fileURLToPath(
      new URL(
        "../../../mustaflow/src/pages/projects/components/inline-build-results.tsx",
        import.meta.url,
      ),
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
