import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("./canvas.ts", import.meta.url), "utf8");
const routesIndexSource = readFileSync(new URL("./index.ts", import.meta.url), "utf8");

function between(start: string, end: string): string {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  expect(startIndex).toBeGreaterThanOrEqual(0);
  expect(endIndex).toBeGreaterThan(startIndex);
  return source.slice(startIndex, endIndex);
}

describe("canvas project retirement lifecycle", () => {
  it("makes both shared-preview handlers resolve through an active project", () => {
    const authenticated = between(
      'router.get("/canvas/share/:token/{*splat}"',
      "// ── Cross-project Variant Library",
    );
    const publicRoute = between(
      'publicCanvasRouter.get("/canvas/share/:token/{*splat}"',
      'publicCanvasRouter.get("/canvas/ab/:testId/{*splat}"',
    );

    expect(authenticated).toContain("findActiveSharedCanvasVariant(token)");
    expect(publicRoute).toContain("findActiveSharedCanvasVariant(token)");
    expect(source).toContain(".innerJoin(\n      projectsTable,");
    expect(source).toContain("isNull(projectsTable.deletedAt)");
  });

  it("makes both A/B serve handlers use active-project reads and guarded view writes", () => {
    const authenticated = between(
      'router.get("/canvas/ab/:testId/{*splat}"',
      "// ── Public canvas router",
    );
    const publicRoute = between(
      'publicCanvasRouter.get("/canvas/ab/:testId/{*splat}"',
      'publicCanvasRouter.post("/canvas/ab-tests/:testId/convert"',
    );

    for (const handler of [authenticated, publicRoute]) {
      expect(handler).toContain("findActiveCanvasAbTest(testId)");
      expect(handler).toContain("recordActiveCanvasAbTestMetric(");
      expect(handler).not.toContain("db.update(canvasAbTestsTable)");
    }
    const activeTestRead = between(
      "async function findActiveCanvasAbTest(",
      "async function recordActiveCanvasAbTestMetric(",
    );
    expect(activeTestRead).toContain('eq(canvasAbTestsTable.status, "running")');
  });

  it("makes both conversion handlers write only through the active-project predicate", () => {
    const authenticated = between(
      'router.post("/canvas/ab-tests/:testId/convert"',
      "// ── GET /api/canvas/ab/:testId",
    );
    const publicRoute = between(
      'publicCanvasRouter.post("/canvas/ab-tests/:testId/convert"',
      'publicCanvasRouter.get("/canvas/library"',
    );

    for (const handler of [authenticated, publicRoute]) {
      expect(handler).toContain("recordActiveCanvasAbTestConversion(");
      expect(handler).not.toContain("db.update(canvasAbTestsTable)");
    }
    const metricWriter = between(
      "async function recordActiveCanvasAbTestMetric(",
      "function serializeVariant(",
    );
    expect(metricWriter).toContain('eq(canvasAbTestsTable.status, "running")');
    expect(metricWriter).toContain("activeCanvasAbTestProject");
  });

  it("keeps share-token and A/B creation locked after a disconnected response", () => {
    const shareCreation = between(
      '"/projects/:id/canvas/variants/:vid/share"',
      "// ── GET /api/canvas/share",
    );
    const abCreation = between(
      '"/projects/:id/canvas/ab-tests"',
      "// GET /api/projects/:id/canvas/ab-tests",
    );

    for (const handler of [shareCreation, abCreation]) {
      expect(handler).toContain("responseProjectLifecycleSession(res)");
      expect(handler).toContain("await lifecycleSession.assertActive()");
      expect(handler).toContain("withCanvasProjectLifecycleHold(res");
      expect(handler).toContain('res.status(404).json({ error: "Project not found" })');
    }
    expect(shareCreation.indexOf("withCanvasProjectLifecycleHold(res")).toBeLessThan(
      shareCreation.indexOf(".update(canvasVariantsTable)"),
    );
    expect(abCreation.indexOf("withCanvasProjectLifecycleHold(res")).toBeLessThan(
      abCreation.indexOf(".insert(canvasAbTestsTable)"),
    );
    const lifecycleHold = between(
      "async function withCanvasProjectLifecycleHold",
      "/**\n * Per-variant style hints",
    );
    expect(lifecycleHold).toContain("holdResponseProjectLifecycleSession(res)");
    expect(lifecycleHold).toContain("finally {");
    expect(lifecycleHold).toContain("await release()");
    expect(
      routesIndexSource.indexOf("router.use(requireActiveProjectMutationLifecycleSession)"),
    ).toBeLessThan(routesIndexSource.indexOf("router.use(canvasRouter)"));
  });
});
