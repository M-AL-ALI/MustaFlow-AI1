import { describe, expect, it } from "vitest";
import { extractNamedFunction } from "../../../api-server/src/lib/source-ast-test-helper";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Normalize CRLF so source-string assertions pass on Windows checkouts too.
const read = (rel: string) =>
  readFileSync(path.join(__dirname, rel), "utf8").replace(/\r\n/g, "\n");

describe("Mobile Ora — file version history parity (Phase 2)", () => {
  const api = read("../api.ts");
  const types = read("../types.ts");
  const sheet = read("../../components/ora/VersionHistorySheet.tsx");
  const index = read("../../app/(home)/index.tsx");
  const library = read("../../app/(home)/library.tsx");

  it("api exposes listAssetVersions and restoreAssetVersion against the versions routes", () => {
    expect(api).toContain(
      "export function listAssetVersions(id: number): Promise<OraAssetVersionsResponse> {",
    );
    expect(api).toContain("`/api/ora/assets/${id}/versions`");
    expect(api).toContain("export function restoreAssetVersion(");
    expect(api).toContain("`/api/ora/assets/${versionAssetId}/restore`");
    expect(api).toContain('method: "POST"');
  });

  it("versions/restore paths get a bearer token via the /api/ora/ auth prefix", () => {
    const fnBody = extractNamedFunction(api, "pathRequiresAuth");
    expect(fnBody).toContain("function pathRequiresAuth");
    expect(fnBody).toContain('path.startsWith("/api/ora/")');
  });

  it("wire types mirror the server versions/restore contract", () => {
    expect(types).toContain("export interface OraAssetVersion {");
    expect(types).toContain("versionNumber: number;");
    expect(types).toContain("editSummary: string | null;");
    expect(types).toContain("isCurrent: boolean;");
    expect(types).toContain("export interface OraAssetVersionsResponse {");
    expect(types).toContain("currentAssetId: number;");
    expect(types).toContain("export interface RestoreAssetVersionResponse {");
    expect(types).toContain("restoredFromVersion: number;");
  });

  it("sheet lists newest-first, reloads against the NEW head after restore, and notifies the caller", () => {
    // Server returns v1-first; the sheet must reverse for newest-first display.
    expect(sheet).toContain("[...res.versions].reverse()");
    expect(sheet).toContain("const res = await restoreAssetVersion(version.id);");
    expect(sheet).toContain("onRestored?.(res.assetId);");
    expect(sheet).toContain("await load(res.assetId);");
    // Current head must not offer Restore.
    expect(sheet).toContain("{!v.isCurrent && (");
  });

  it("chat file card gates History on a durable asset id and repoints Save/View after restore", () => {
    // Hidden for anonymous users (no durable asset id on the generated file).
    expect(index).toContain("{generatedFile.assetId != null ? (");
    expect(index).toContain('accessibilityLabel="View version history"');
    // After restore the card must use the NEW head and drop stale inline bytes.
    expect(index).toContain("const { fileData: _staleBytes, ...rest } = generatedFile;");
    expect(index).toContain("generatedFile = { ...rest, assetId: restoredAssetId };");
    expect(index).toContain("onRestored={setRestoredAssetId}");
    // Save/View operate on the restore-aware file, not the raw message copy.
    expect(index).toContain("const outcome = await saveGeneratedFile(generatedFile);");
    expect(index).toContain("const file = generatedFile;");
  });

  it("Library exposes History for file assets only and reloads after restore", () => {
    expect(library).toContain(
      'onShowHistory={a.kind === "file" ? () => setHistoryAssetId(a.id) : undefined}',
    );
    expect(library).toContain("onRestored={() => void reload()}");
    expect(library).toContain(
      'import { VersionHistorySheet } from "@/components/ora/VersionHistorySheet";',
    );
  });
});
