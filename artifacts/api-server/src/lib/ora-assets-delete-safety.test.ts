import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("Ora asset deletion reference ordering", () => {
  const source = readFileSync(new URL("./ora-assets.ts", import.meta.url), "utf8");
  const start = source.indexOf("export async function deleteOraAsset");
  const body = source.slice(start);

  it("locks the live owner-scoped Ora row before a fresh reference statement", () => {
    const begin = body.indexOf('client.query("BEGIN ISOLATION LEVEL READ COMMITTED")');
    const selected = body.indexOf("const selected = await client.query");
    const rowLock = body.indexOf("FOR UPDATE", selected);
    const references = body.indexOf("const references = await client.query", rowLock);
    const softDelete = body.indexOf("UPDATE ora_assets SET deleted_at=NOW()", references);

    expect(start).toBeGreaterThanOrEqual(0);
    expect(begin).toBeGreaterThanOrEqual(0);
    expect(selected).toBeGreaterThan(begin);
    expect(rowLock).toBeGreaterThan(selected);
    expect(references).toBeGreaterThan(rowLock);
    expect(softDelete).toBeGreaterThan(references);
    expect(body.slice(selected, references)).not.toContain("FROM ora_file_contexts");
    expect(body.slice(references, softDelete)).toContain("FROM ora_file_contexts");
    expect(body.slice(references, softDelete)).toContain("FROM brand_kits");
    expect(body.slice(references, softDelete)).toContain("FROM support_tickets");
  });

  it("preserves fail-closed references and the legacy cleanup branch", () => {
    expect(body).toContain("references.rows[0]?.referenced !== false");
    expect(body).toContain('return "referenced"');
    expect(body).toContain("if (unifiedAssetId === null)");
    expect(body).toContain('return "cleanup-pending"');
  });
});
