import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const composer = readFileSync(
  resolve(process.cwd(), "src/pages/projects/components/queue-composer.tsx"),
  "utf8",
);
const project = readFileSync(resolve(process.cwd(), "src/pages/projects/[id].tsx"), "utf8");
const history = readFileSync(
  resolve(process.cwd(), "src/pages/projects/components/chat-history.tsx"),
  "utf8",
);

describe("primary Zero chat uses the governed asset registry", () => {
  it("has one upload doorway and cannot regress to either legacy endpoint", () => {
    expect(composer).toContain("uploadProjectAsset({");
    expect(composer).not.toContain("/attachments/upload-url");
    expect(composer).not.toContain("/uploads/request-url");
    expect(composer).not.toContain("MAX_IMAGE_BYTES");
  });

  it("delivers image and file identities through both regular and streaming sends", () => {
    expect(composer).toContain("pending.length > 0 ? pending : undefined");
    expect(project).not.toContain("const imageOnly = attachments?.filter");
    expect(project).toContain("attachments && attachments.length > 0 ? { attachments }");
  });

  it("shows durable file attachments in chat history", () => {
    expect(history).toContain('if (att.kind === "file")');
    expect(history).toContain("href={att.url}");
    expect(history).toContain('att.name ?? "Attached file"');
  });
});
