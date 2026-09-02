import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const canonical = readFileSync(
  new URL("../../../../lib/api-spec/openapi.yaml", import.meta.url),
  "utf8",
);
const publicMirror = readFileSync(
  new URL("../../../mustaflow/public/openapi.yaml", import.meta.url),
  "utf8",
);

function projectDeletionContract(source: string): string {
  const start = source.indexOf("  /projects/{id}:");
  const end = source.indexOf("  /projects/summary:", start);
  if (start < 0 || end < 0) throw new Error("project_deletion_openapi_contract_missing");
  return source.slice(start, end);
}

describe("project deletion OpenAPI contract", () => {
  for (const [label, source] of [
    ["canonical", canonical],
    ["public mirror", publicMirror],
  ] as const) {
    it(`${label} documents governed Trash and owner permanent deletion`, () => {
      const contract = projectDeletionContract(source);
      expect(contract).toContain("operationId: deleteProject");
      expect(contract).toContain('"202":');
      expect(contract).not.toMatch(/operationId: deleteProject[\s\S]*?"204":/u);
      expect(contract).toContain("/projects/{id}/permanent-deletion-impact:");
      expect(contract).toContain("operationId: permanentlyDeleteProject");
      expect(contract).toContain("Idempotency-Key");
      expect(contract).toContain("/project-purge-operations/{operationId}:");
      expect(source).toContain("ProjectPurgeOperation:");
      expect(source).toContain("ProjectPurgeTerminalEvidence:");
    });
  }

  it("admits purge status reads through the pre-auth route-prefix guard", () => {
    const routeIndex = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    const prefixGuard = routeIndex.indexOf("const KNOWN_PREFIXES");
    const authWall = routeIndex.indexOf("router.use(attachUser)");
    const purgeMount = routeIndex.indexOf("router.use(projectPurgeRouter)");

    expect(prefixGuard).toBeGreaterThanOrEqual(0);
    expect(routeIndex.slice(prefixGuard, authWall)).toContain('"/project-purge-operations"');
    expect(authWall).toBeGreaterThan(prefixGuard);
    expect(purgeMount).toBeGreaterThan(authWall);
  });
});
