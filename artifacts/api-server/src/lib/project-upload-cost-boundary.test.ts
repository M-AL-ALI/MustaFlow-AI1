import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import * as ts from "typescript";

const root = path.resolve(import.meta.dirname, "..");

function findNodes<T extends ts.Node>(scope: ts.Node, matches: (node: ts.Node) => node is T): T[] {
  const nodes: T[] = [];
  function visit(node: ts.Node): void {
    if (matches(node)) nodes.push(node);
    // Inspect the selected executable scope without counting uncalled nested callbacks.
    if (node !== scope && ts.isFunctionLike(node)) return;
    ts.forEachChild(node, visit);
  }
  visit(scope);
  return nodes;
}

function isMethodCall(call: ts.CallExpression, receiver: string, method: string): boolean {
  return (
    ts.isPropertyAccessExpression(call.expression) &&
    ts.isIdentifier(call.expression.expression) &&
    call.expression.expression.text === receiver &&
    call.expression.name.text === method
  );
}

function governedUploadOptions(source: string): Record<string, string>[] {
  const ast = ts.createSourceFile(
    "panel.tsx",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const printer = ts.createPrinter({ removeComments: true });
  const options: Record<string, string>[] = [];
  function visit(node: ts.Node): void {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "uploadProjectAsset" &&
      node.arguments[0] &&
      ts.isObjectLiteralExpression(node.arguments[0])
    ) {
      const fields: Record<string, string> = {};
      for (const property of node.arguments[0].properties) {
        if (ts.isShorthandPropertyAssignment(property)) {
          fields[property.name.text] = property.name.text;
        } else if (ts.isPropertyAssignment(property) && ts.isIdentifier(property.name)) {
          fields[property.name.text] = ts.isStringLiteral(property.initializer)
            ? property.initializer.text
            : printer
                .printNode(ts.EmitHint.Unspecified, property.initializer, ast)
                .replace(/\s+/g, "");
        }
      }
      options.push(fields);
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  return options;
}

describe("project upload cost boundary", () => {
  it("checks real upload calls independently of whitespace, quotes and comments", () => {
    expect(
      governedUploadOptions("// uploadProjectAsset({ projectId, file, source: 'picker' })"),
    ).toEqual([]);
    expect(
      governedUploadOptions(
        "async function upload() { await uploadProjectAsset({\n projectId,\n file,\n source: 'picker',\n signal: scope.signal,\n }); }",
      ),
    ).toEqual([{ projectId: "projectId", file: "file", source: "picker", signal: "scope.signal" }]);
  });

  it("keeps every legacy direct project signer closed", () => {
    const source = fs.readFileSync(path.join(root, "routes", "uploads.ts"), "utf8");
    for (const next of [
      "// POST /projects/:id/uploads/request-url",
      "// POST /projects/:id/uploads — register",
    ]) {
      const comment = source.indexOf(next);
      const start = source.indexOf("router.post(", comment);
      const end = source.indexOf("\n// ", start);
      const route = source.slice(start, end < 0 ? undefined : end);
      expect(comment).toBeGreaterThan(-1);
      expect(start).toBeGreaterThan(comment);
      expect(route).toContain("res.status(410)");
      expect(route).not.toContain("getObjectEntityUploadURL(");
    }
  });

  it("proves provider deletion before removing the durable upload row", () => {
    const source = fs.readFileSync(path.join(root, "routes", "uploads.ts"), "utf8");
    const ast = ts.createSourceFile("uploads.ts", source, ts.ScriptTarget.Latest, true);
    const endpoints = findNodes(ast, ts.isCallExpression).filter(
      (call) =>
        isMethodCall(call, "router", "delete") &&
        call.arguments[0] &&
        ts.isStringLiteral(call.arguments[0]) &&
        call.arguments[0].text === "/projects/:id/uploads/:uploadId",
    );
    expect(endpoints).toHaveLength(1);
    const handler = endpoints[0]!.arguments.at(-1);
    if (
      !handler ||
      !(ts.isArrowFunction(handler) || ts.isFunctionExpression(handler)) ||
      !ts.isBlock(handler.body)
    ) {
      throw new Error("Missing legacy upload deletion handler");
    }
    const calls = findNodes(handler.body, ts.isCallExpression);
    function awaitedStatement(name: string): ts.ExpressionStatement {
      const matches = calls.filter(
        (call) => ts.isIdentifier(call.expression) && call.expression.text === name,
      );
      expect(matches).toHaveLength(1);
      const call = matches[0]!;
      if (!ts.isAwaitExpression(call.parent) || !ts.isExpressionStatement(call.parent.parent)) {
        throw new Error("Expected a directly awaited statement: " + name);
      }
      return call.parent.parent;
    }
    const provider = awaitedStatement("deleteTrackedAssetStorageObjects");
    const recorded = awaitedStatement("recordAssetDeleted");
    const providerCall = (provider.expression as ts.AwaitExpression)
      .expression as ts.CallExpression;
    expect(providerCall.arguments).toHaveLength(1);
    const storageObjects = providerCall.arguments[0]!;
    expect(
      ts.isPropertyAccessExpression(storageObjects) &&
        ts.isIdentifier(storageObjects.expression) &&
        storageObjects.expression.text === "pending" &&
        storageObjects.name.text === "storageObjects",
    ).toBe(true);
    const providerBlock = provider.parent;
    if (!ts.isBlock(providerBlock) || !ts.isTryStatement(providerBlock.parent)) {
      throw new Error("Expected provider cleanup inside a guarded try block");
    }
    const cleanup = providerBlock.parent;
    expect(cleanup.tryBlock).toBe(providerBlock);
    expect(cleanup.finallyBlock).toBeUndefined();
    expect(cleanup.catchClause).toBeDefined();
    expect(cleanup.catchClause!.block.statements.some(ts.isReturnStatement)).toBe(true);
    expect(recorded.parent).toBe(cleanup.parent);
    expect(recorded.getStart(ast)).toBeGreaterThan(cleanup.end);

    const deletionBranch = cleanup.parent;
    if (!ts.isBlock(deletionBranch) || !ts.isIfStatement(deletionBranch.parent)) {
      throw new Error("Expected cleanup and deletion receipt in the same state branch");
    }
    const stateGuard = deletionBranch.parent;
    expect(stateGuard.thenStatement).toBe(deletionBranch);
    expect(stateGuard.parent).toBe(handler.body);

    const deletes = calls.filter(
      (call) =>
        isMethodCall(call, "db", "delete") &&
        call.arguments[0] &&
        ts.isIdentifier(call.arguments[0]) &&
        call.arguments[0].text === "projectUploadsTable",
    );
    expect(deletes).toHaveLength(1);
    const property = deletes[0]!.parent;
    if (
      !ts.isPropertyAccessExpression(property) ||
      property.name.text !== "where" ||
      !ts.isCallExpression(property.parent) ||
      property.parent.expression !== property
    ) {
      throw new Error("Expected a predicate on upload metadata deletion");
    }
    const removal = property.parent;
    if (!ts.isAwaitExpression(removal.parent) || !ts.isExpressionStatement(removal.parent.parent)) {
      throw new Error("Expected awaited upload metadata deletion");
    }
    const metadata = removal.parent.parent;
    expect(metadata.parent).toBe(handler.body);
    expect(metadata.getStart(ast)).toBeGreaterThan(stateGuard.end);
    expect(removal.arguments).toHaveLength(1);
    const predicate = removal.arguments[0]!;
    if (
      !ts.isCallExpression(predicate) ||
      !ts.isIdentifier(predicate.expression) ||
      predicate.expression.text !== "and"
    ) {
      throw new Error("Expected conjunctive upload identity predicates");
    }
    const printer = ts.createPrinter({ removeComments: true });
    const printed = (node: ts.Node) =>
      printer.printNode(ts.EmitHint.Unspecified, node, ast).replace(/\s+/g, "");
    expect(predicate.arguments.map(printed).sort()).toEqual(
      [
        "eq(projectUploadsTable.id,row.id)",
        "eq(projectUploadsTable.projectId,Number(req.params.id))",
        "eq(projectUploadsTable.objectPath,row.objectPath)",
      ].sort(),
    );
    const references = calls.filter(
      (call) =>
        ts.isIdentifier(call.expression) && call.expression.text === "legacyUploadIsReferenced",
    );
    expect(references).toHaveLength(1);
    expect(ts.isAwaitExpression(references[0]!.parent)).toBe(true);
    expect(references[0]!.getStart(ast)).toBeLessThan(provider.getStart(ast));
    const route = printer.printNode(ts.EmitHint.Unspecified, handler.body, ast);
    expect(route).toContain("storage delete did not conclude");
    expect(route).toContain('eq(assetsTable.source, "legacy-project-upload")');
    expect(route).toContain(
      'mirror.storageBackend !== "legacy-object" && mirror.storageBackend !== "r2"',
    );
  });

  it("keeps the unowned legacy signer closed", () => {
    const source = fs.readFileSync(path.join(root, "routes", "storage.ts"), "utf8");
    const route = source.slice(
      source.indexOf('router.post("/storage/uploads/request-url"'),
      source.indexOf("/**\n * GET /storage/public-objects"),
    );
    expect(route).toContain("res.status(410)");
    expect(route).not.toContain("getObjectEntityUploadURL()");
  });

  it("keeps the legacy attachment signer closed in favor of governed assets", () => {
    const api = fs.readFileSync(path.join(root, "routes", "uploads.ts"), "utf8");
    const web = fs.readFileSync(
      path.resolve(
        root,
        "..",
        "..",
        "mustaflow",
        "src",
        "pages",
        "dev-workspace",
        "components",
        "dev-chat-panel.tsx",
      ),
      "utf8",
    );
    const route = api.slice(
      api.indexOf('"/projects/:id/attachments/upload-url"'),
      api.indexOf("// POST /projects/:id/uploads/request-url"),
    );
    expect(route).toContain("res.status(410)");
    expect(route).not.toContain("getObjectEntityUploadURL()");
    expect(governedUploadOptions(web)).toContainEqual(
      expect.objectContaining({
        projectId: "projectId",
        file: "file",
        source: "paste",
        signal: "scope.signal",
      }),
    );
    expect(web).not.toContain("/attachments/upload-url");
  });

  it("moves the developer storage panel onto the unified governed asset path", () => {
    const panel = fs.readFileSync(
      path.resolve(
        root,
        "..",
        "..",
        "mustaflow",
        "src",
        "pages",
        "dev-workspace",
        "components",
        "object-storage-panel.tsx",
      ),
      "utf8",
    );
    expect(governedUploadOptions(panel)).toContainEqual(
      expect.objectContaining({
        projectId: "projectId",
        file: "file",
        source: "picker",
        signal: "scope.signal",
      }),
    );
    expect(panel).toContain("/api/assets?projectId=");
    expect(panel).toContain('asset.source !== "legacy-project-upload"');
    expect(panel).not.toContain("/uploads/request-url");
    expect(panel).not.toContain("/api/storage/public-objects/{objectPath}");
  });
});
