import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("Aura inline image edit product boundaries", () => {
  it.each([
    {
      path: "./use-ora-chat.ts",
      start: "const editInlineImage = useCallback(",
      end: "const clearConversation = useCallback(",
      sourceId: "sourceImageId",
    },
    {
      path: "../../../ora-mobile/lib/api.ts",
      start: "export async function editImage(",
      end: "export function getOraxCapabilities(",
      sourceId: "imageId",
    },
  ])("keeps edit, status, and bytes inside Ora in $path", ({ path, start, end, sourceId }) => {
    const source = readFileSync(new URL(path, import.meta.url), "utf8");
    const startIndex = source.indexOf(start);
    const endIndex = source.indexOf(end, startIndex);
    expect(startIndex).toBeGreaterThanOrEqual(0);
    expect(endIndex).toBeGreaterThan(startIndex);
    const block = source.slice(startIndex, endIndex);

    expect(block).toContain("/api/ora/images/${" + sourceId + "}/edit");
    expect(block).toContain("/api/ora/images/status/${jobId}");
    expect(block).not.toContain("/api/images/");
    expect(block).not.toMatch(/\b(?:origin|billingMode|productScope)\s*:/);
    expect(block).toContain("imageId: newImageId");
    expect(block).toContain(String.raw`/^\/api\/ora\/canonical-assets\/[1-9]\d*\/content$/`);
    expect(block).toContain(".test(fileUrl)");
    expect(block).not.toMatch(
      /\/api\/ora\/(?:assets|canonical-assets)\/\$\{(?:sourceImageId|imageId|newImageId)\}/,
    );

    if (sourceId === "sourceImageId") {
      expect(block).toContain("const turnGeneration = conversationResetGenRef.current");
      expect(block).toMatch(/safeAuthFetch\(\s*`\$\{BASE\}\$\{fileUrl\}`\s*\)/);
      expect(block).toContain("imageId: newImageId,");
    } else {
      expect(block).toMatch(/fetchOrThrow\(\s*url\(\s*fileUrl\s*\)\s*\)/);
      expect(block).toContain("return { displayUrl, newImageId }");
    }
  });

  it("preserves the Nabu project chat cards' edit and polling routes", () => {
    const path = "../pages/projects/components/chat-history.tsx";
    const source = readFileSync(new URL(path, import.meta.url), "utf8");
    expect(source.match(/\/api\/images\/\$\{imageId\}\/edit/g)).toHaveLength(2);
    expect(source.match(/\/api\/images\/status\/\$\{jobId\}/g)).toHaveLength(1);
  });
});
