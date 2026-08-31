import { readFileSync, readdirSync } from "node:fs";
import { relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { extractRouteHandler } from "./source-ast-test-helper";

const sourceRoot = resolve(import.meta.dirname, "..");
const projectFileMutationPattern = /\.(?:insert|update|delete)\(\s*projectFilesTable\s*\)/gu;
const reconciliationPattern = /reconcileProjectFileAssetUsage\(/gu;

function productionTypeScriptFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = resolve(directory, entry.name);
    if (entry.isDirectory()) return productionTypeScriptFiles(absolute);
    if (!entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts")) return [];
    return [absolute];
  });
}

const reconciledMutationInventory = new Map<string, { mutations: number; reconciliations: number }>(
  [
    ["lib/blueprints.ts", { mutations: 2, reconciliations: 1 }],
    ["lib/canvas-variant-graduation.ts", { mutations: 2, reconciliations: 1 }],
    ["lib/eslint-fix-all.ts", { mutations: 1, reconciliations: 1 }],
    ["lib/project-file-writer.ts", { mutations: 3, reconciliations: 1 }],
    ["routes/artifacts.ts", { mutations: 1, reconciliations: 1 }],
    ["routes/assets.ts", { mutations: 4, reconciliations: 2 }],
    ["routes/blocks.ts", { mutations: 3, reconciliations: 3 }],
    ["routes/checkpoints.ts", { mutations: 2, reconciliations: 1 }],
    ["routes/duplicate.ts", { mutations: 1, reconciliations: 1 }],
    ["routes/files.ts", { mutations: 4, reconciliations: 5 }],
    ["routes/security.ts", { mutations: 2, reconciliations: 1 }],
    ["routes/v1/files.ts", { mutations: 2, reconciliations: 2 }],
    ["routes/visual-edit.ts", { mutations: 2, reconciliations: 2 }],
  ],
);

// These writes cannot introduce a same-project ready asset URL: they are
// fixed scaffolds/config edits, or seed a newly-created project before it has
// any project-scoped assets. Exact mutation counts keep this exception list
// from silently covering a new write path in the same source file.
const nonAssetMutationInventory = new Map<string, number>([
  ["repair-project86-frontend.ts", 1],
  ["routes/eas.ts", 1],
  ["routes/packages.ts", 1],
  ["routes/projects.ts", 8],
  ["routes/templates.ts", 2],
]);

describe("project-file asset usage mutation census", () => {
  it("requires every asset-capable project-file mutation source to reconcile in its transaction", () => {
    const discovered = new Map<string, { mutations: number; reconciliations: number }>();
    for (const absolute of productionTypeScriptFiles(sourceRoot)) {
      const source = readFileSync(absolute, "utf8");
      const mutations = source.match(projectFileMutationPattern)?.length ?? 0;
      if (mutations === 0) continue;
      const file = relative(sourceRoot, absolute).replaceAll("\\", "/");
      discovered.set(file, {
        mutations,
        reconciliations: source.match(reconciliationPattern)?.length ?? 0,
      });
    }

    expect([...discovered.keys()].sort()).toEqual(
      [...reconciledMutationInventory.keys(), ...nonAssetMutationInventory.keys()].sort(),
    );
    for (const [file, expected] of reconciledMutationInventory) {
      expect(discovered.get(file), file).toEqual(expected);
      expect(readFileSync(resolve(sourceRoot, file), "utf8"), file).toContain(
        "reconcileProjectFileAssetUsage(tx,",
      );
    }
    for (const [file, mutations] of nonAssetMutationInventory) {
      expect(discovered.get(file), file).toEqual({ mutations, reconciliations: 0 });
    }
  });

  it("does not bulk-delete unrelated usages when replacing an asset", () => {
    const source = readFileSync(resolve(sourceRoot, "routes/assets.ts"), "utf8");
    const replacement = extractRouteHandler(
      source,
      "post",
      "/projects/:id/assets/:assetId/replace",
    );

    expect(replacement).toContain("reconcileProjectFileAssetUsage(tx,");
    expect(replacement).not.toContain(".delete(assetUsageTable)");
    expect(replacement).toContain(
      "eq(assetUsageTable.consumer, PROJECT_FILE_ASSET_USAGE_CONSUMER)",
    );
  });
});
