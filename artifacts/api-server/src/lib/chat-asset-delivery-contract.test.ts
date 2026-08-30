import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const messages = readFileSync(resolve(process.cwd(), "src/routes/messages.ts"), "utf8");
const jobs = readFileSync(resolve(process.cwd(), "src/lib/jobs.ts"), "utf8");
const images = readFileSync(resolve(process.cwd(), "src/routes/images.ts"), "utf8");

describe("chat asset delivery remains governed end to end", () => {
  it("authorizes asset identities and records deletion-blocking message usage atomically", () => {
    expect(messages.match(/readReadyProjectAssets\(\{/gu)).toHaveLength(2);
    expect(messages.match(/tx\.insert\(assetUsageTable\)/gu)).toHaveLength(2);
    expect(messages).toContain("consumer: `chat-message:${message.id}`");
    expect(messages).toContain("appendGovernedAssetContext");
  });

  it("hydrates only images and always keeps the project authorization boundary", () => {
    expect(jobs).toContain('(entry as { kind?: unknown }).kind !== "image"');
    expect(jobs).toContain("fetchAttachmentAsDataUri(url, projectId)");
    expect(jobs).not.toContain("fetchAttachmentAsDataUri(url);");
  });

  it("puts composer-generated images through quota, private R2, and usage tracking", () => {
    expect(images.indexOf("reserveAsset({")).toBeLessThan(images.indexOf("putAssetBuffer({"));
    expect(images.indexOf("putAssetBuffer({")).toBeLessThan(images.indexOf("completeAsset({"));
    expect(images).toContain("resolveArtifactId(project.id, null)");
    expect(images).toContain("eq(projectFilesTable.artifactId, artifactId)");
    expect(images).toMatch(/tx\s*\.insert\(assetUsageTable\)/u);
    expect(images).toContain("savedPath = safeSavePath");
    expect(images).toContain("...(savedPath ? { savedPath } : {})");
    expect(images).toContain("url: `/api/assets/${reservation.id}/content`");
    expect(images).not.toContain("existing.find(() => false)");
  });
});
