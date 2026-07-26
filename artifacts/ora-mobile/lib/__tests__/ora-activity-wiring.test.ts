import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  ORA_ACTIVITY_TEXT,
  oraActivityStep,
  oraActivityText,
  oraActivityToolForRoutedTool,
  parseOraActivityStep,
} from "@workspace/ora-contracts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Normalize CRLF so source-string assertions pass on Windows checkouts too.
const read = (rel: string) =>
  readFileSync(path.join(__dirname, rel), "utf8").replace(/\r\n/g, "\n");

/**
 * Ora Universal Live Activity Trace — mobile wiring.
 *
 * api.ts must parse the new SSE `activity` event alongside `status`/`token`
 * and forward it via the onActivity callback; the home screen must feed the
 * step into OraThinkingRow (fade-in/fade-out via reanimated) and clear it on
 * the first real answer token. Wording comes from the shared
 * @workspace/ora-contracts copy map so mobile matches the website exactly.
 */
describe("Mobile Ora — activity event parsing (shared parser)", () => {
  it("accepts a valid activity frame", () => {
    expect(
      parseOraActivityStep({
        type: "activity",
        tool: "repo-analysis",
        phase: "start",
        text: "Reading model-router.ts…",
      }),
    ).toEqual({ tool: "repo-analysis", phase: "start", text: "Reading model-router.ts…" });
  });

  it("rejects malformed frames so a bad event can never break the stream loop", () => {
    expect(parseOraActivityStep(undefined)).toBeNull();
    expect(parseOraActivityStep("activity")).toBeNull();
    expect(parseOraActivityStep({ tool: "web-search", phase: "start" })).toBeNull();
    expect(parseOraActivityStep({ tool: "sql", phase: "start", text: "x" })).toBeNull();
    expect(parseOraActivityStep({ tool: "web-search", phase: "done", text: "x" })).toBeNull();
  });

  it("shares the website's wording map (identical copy on both surfaces)", () => {
    expect(ORA_ACTIVITY_TEXT["web-search"].start).toBe("Searching the web…");
    expect(oraActivityStep("file-generation", "start").text).toBe("Generating your file…");
    expect(oraActivityToolForRoutedTool("search")).toBe("web-search");
    expect(oraActivityText("dataset-analysis", "start")).toBe("Analyzing your data…");
    expect(oraActivityToolForRoutedTool("dataset_analysis")).toBe("dataset-analysis");
    expect(oraActivityToolForRoutedTool("unknown_tool")).toBeNull();
  });
});

describe("Mobile Ora — api.ts forwards activity events", () => {
  const api = read("../api.ts");

  it("streamChatNative accepts the onActivity callback", () => {
    const sig = api.slice(
      api.indexOf("export async function streamChatNative("),
      api.indexOf("): Promise<StreamChatNativeResult>"),
    );
    expect(sig).toContain("onActivity?: (step: OraActivityStep) => void");
  });

  it("parses the SSE activity event and forwards the validated step", () => {
    const idx = api.indexOf('} else if (type === "activity") {');
    expect(idx).toBeGreaterThan(-1);
    const body = api.slice(idx, idx + 300);
    expect(body).toContain("parseOraActivityStep(parsed)");
    expect(body).toContain("if (step) onActivity?.(step);");
  });

  it("synthesizes the tool's start step from the specialist bounce signal", () => {
    expect(api).toContain("oraActivityToolForRoutedTool(bounce.tool)");
    expect(api).toContain('onActivity?.(oraActivityStep(bouncedTool, "start"));');
  });

  it("ChatResponse carries the server-reported terminal steps", () => {
    const types = read("../types.ts");
    expect(types).toContain("activity?: OraActivityStep[];");
  });
});

describe("Mobile Ora — home screen feeds the thinking row", () => {
  const index = read("../../app/(home)/index.tsx");

  it("passes onActivity into streamChatNative and ignores late frames", () => {
    expect(index).toContain("(step) => {");
    expect(index).toContain("if (streamedContent.length === 0) pushActivity(step);");
  });

  it("clears the trace on the first real answer token", () => {
    const idx = index.indexOf("if (streamedContent.length === 0) {");
    expect(idx).toBeGreaterThan(-1);
    const body = index.slice(idx, idx + 220);
    expect(body).toContain("setStreamStatus(null);");
    expect(body).toContain("setStreamActivity(null);");
  });

  it("narrates attachment and dataset reading with the shared name-aware wording", () => {
    expect(index).toContain("ORA_ANALYZING_IMAGE_TEXT");
    expect(index).toContain("oraAnalyzingDatasetText(attch.filename)");
    expect(index).toContain("oraReadingFileText(attch.filename)");
    const datasetHelper = "oraAnalyzingDatasetText(attch.filename)";
    const datasetIndex = index.indexOf(datasetHelper);
    expect(datasetIndex).toBeGreaterThan(-1);
    expect(index.slice(datasetIndex - 120, datasetIndex + datasetHelper.length)).toContain(
      '"dataset-analysis"',
    );
    expect(index).toContain('oraActivityStep("dataset-analysis", "ok")');
  });

  it("applies server-reported terminal steps from /chat fallbacks", () => {
    expect(index).toContain("const applyServerActivity = (res: ChatResponse | null) => {");
    const applied = index.split("applyServerActivity(res);").length - 1;
    expect(applied).toBeGreaterThanOrEqual(3);
  });

  it("renders the activity step through OraThinkingRow", () => {
    expect(index).toContain("activity={streamActivity}");
  });
});

describe("Mobile Ora — OraThinkingRow fade lifecycle", () => {
  const row = read("../../components/ora/OraThinkingRow.tsx");

  it("fades the activity label in and out with reanimated", () => {
    expect(row).toContain("entering={FadeIn.duration(220)}");
    expect(row).toContain("exiting={FadeOut.duration(180)}");
    // Keyed by step id + phase so a new step (or a terminal update) remounts.
    expect(row).toContain("key={`${activity.id}:${activity.phase}`}");
  });

  it("styles failed steps distinctly while staying subtle otherwise", () => {
    expect(row).toContain('activity?.phase === "fail"');
    expect(row).toContain("c.mutedForeground");
  });
});
