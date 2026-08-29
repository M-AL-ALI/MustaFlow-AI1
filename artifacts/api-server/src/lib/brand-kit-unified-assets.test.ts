import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const knowledgeRoute = readFileSync(new URL("../routes/knowledge.ts", import.meta.url), "utf8");
const assetRoute = readFileSync(new URL("../routes/assets.ts", import.meta.url), "utf8");
const agentLoop = readFileSync(new URL("./agent-loop.ts", import.meta.url), "utf8");

describe("unified brand kit asset contract", () => {
  it("accepts only a ready image owned by the caller as the account logo", () => {
    expect(knowledgeRoute).toContain("eq(assetsTable.ownerUserId, userId)");
    expect(knowledgeRoute).toContain('eq(assetsTable.state, "ready")');
    expect(knowledgeRoute).toContain('logo.mimeType.startsWith("image/")');
    expect(knowledgeRoute).toContain("Choose an image from your asset library for the brand logo.");
  });

  it("teaches Zero to discover and place the account logo instead of linking a private URL", () => {
    expect(knowledgeRoute).toContain("Keep brand colours and fonts in shared theme tokens");
    expect(knowledgeRoute).toContain("Use list_uploads, then place_upload");
    expect(agentLoop).toContain('name: "place_upload"');
    expect(agentLoop).toContain("never link a private /api/assets URL from the app");
    expect(agentLoop).toContain("sql`${assetsTable.context}->>'brandRole' = 'logo'`");
  });

  it("places the logo through the same transactional project-history path as every upload", () => {
    expect(assetRoute).toContain("export async function materializeProjectAsset");
    expect(agentLoop).toContain('await import("../routes/assets")');
    expect(agentLoop).toContain("await materializeProjectAsset({");
    expect(assetRoute).toContain("await db.transaction(async (tx)");
    expect(assetRoute).toMatch(/tx\s*\.insert\(projectFilesTable\)/);
    expect(assetRoute).toMatch(/tx\s*\.insert\(assetUsageTable\)/);
  });
});
