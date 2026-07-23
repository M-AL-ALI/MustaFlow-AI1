import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const read = (rel: string) =>
  readFileSync(path.join(__dirname, rel), "utf8").replace(/\r\n/g, "\n");

describe("Mobile Ora - Phase 9A file/data agent preview parity", () => {
  const types = read("../types.ts");
  const api = read("../api.ts");
  const index = read("../../app/(home)/index.tsx");
  const extras = read("../../components/ora/MessageExtras.tsx");

  it("imports the shared preview type from ora-contracts", () => {
    expect(types).toContain("OraFileAgentPreview");
    const importBlock = types.slice(
      types.indexOf("import type {"),
      types.indexOf('} from "@workspace/ora-contracts";', types.indexOf("import type {")),
    );
    expect(importBlock).toContain("OraFileAgentPreview");
  });

  it("declares preview metadata on chat and stream response contracts", () => {
    expect(types).toContain("fileAgentPreview?: OraFileAgentPreview;");
    expect(api).toContain("fileAgentPreview?: OraFileAgentPreview;");
    expect(api).toContain("fileAgentPreview: resolvedDone.fileAgentPreview");
  });

  it("maps preview metadata onto assistant messages", () => {
    expect(index).toContain(
      "...(res.fileAgentPreview ? { fileAgentPreview: res.fileAgentPreview } : {})",
    );
    expect(index).toContain(
      "...(result.fileAgentPreview ? { fileAgentPreview: result.fileAgentPreview } : {})",
    );
    expect(index).toContain("streamResult.fileAgentPreview");
  });

  it("renders the compact preview card from message or dataset metadata", () => {
    expect(extras).toContain("function OraFileAgentPreviewIndicator");
    expect(extras).toContain("message.fileAgentPreview ?? message.datasetResult?.fileAgentPreview");
    expect(extras).toContain("OraFileAgentPreviewIndicator message={message}");
    expect(extras).toContain("preview.plannedActions");
    expect(extras).toContain("preview.calculations");
    expect(extras).toContain("preview.charts");
  });
});
