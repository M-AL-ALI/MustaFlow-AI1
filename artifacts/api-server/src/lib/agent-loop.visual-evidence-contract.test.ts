import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const dir = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(dir, "agent-loop.ts"), "utf8");

describe("Zero visual evidence wiring", () => {
  it("exposes one paired screenshot contract with exact region geometry", () => {
    const tool = source.slice(
      source.indexOf('name: "take_screenshot"'),
      source.indexOf('name: "web_fetch"'),
    );
    expect(tool).toContain("evidence_phase");
    expect(tool).toContain("pair_id");
    expect(tool).toContain('enum: ["before", "after", "evidence"]');
    expect(tool).toContain("clip:");
  });

  it("stores every successful Zero screenshot before showing it to the user", () => {
    const handler = source.slice(
      source.indexOf('case "take_screenshot"'),
      source.indexOf('case "web_fetch"'),
    );
    expect(handler.indexOf("reserveAsset({")).toBeGreaterThan(0);
    expect(handler.indexOf("putAssetBuffer({")).toBeGreaterThan(handler.indexOf("reserveAsset({"));
    expect(handler.indexOf("completeAsset({")).toBeGreaterThan(handler.indexOf("putAssetBuffer({"));
    expect(handler.indexOf('"visual_evidence"')).toBeGreaterThan(
      handler.indexOf("completeAsset({"),
    );
    expect(handler).toContain('source: "zero-agent-screenshot"');
    expect(handler).toContain('scanState: "not-required"');
  });

  it("cannot finalize while a before image has no matching after image", () => {
    const finalize = source.slice(
      source.indexOf('case "finalize"'),
      source.indexOf('case "list_blueprints"'),
    );
    expect(finalize).toContain("pendingZeroVisualEvidencePairs");
    expect(finalize).toContain("visual_evidence_after_required");
  });

  it("serializes screenshots so quota and pair state cannot race", () => {
    const serial = source.slice(
      source.indexOf("const SERIAL_TOOLS"),
      source.indexOf("// Parse a tool call"),
    );
    expect(serial).toContain('"take_screenshot"');
  });
});
