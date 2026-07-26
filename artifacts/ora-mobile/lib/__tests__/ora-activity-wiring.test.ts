import { describe, expect, it, vi } from "vitest";
import {
  createActivityVisibilityController,
  ACTIVITY_MIN_SHOW_MS,
  shouldShowOraActivityRow,
} from "../activity-visibility";
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

  it("clears the trace on the first real answer token via deferred scheduleClear", () => {
    const idx = index.indexOf("if (streamedContent.length === 0) {");
    expect(idx).toBeGreaterThan(-1);
    // The clear is now deferred through scheduleClear so an activity step that
    // arrives in the same XHR burst has ACTIVITY_MIN_SHOW_MS to paint before
    // being cleared. Expand the slice window to cover the full deferred call.
    const body = index.slice(idx, idx + 700);
    expect(body).toContain("setStreamStatus(null);");
    expect(body).toContain("scheduleClear(");
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

describe("Mobile Ora — activity visibility controller behaviour", () => {
  it("keeps the row rendered when activity and the first token land in one batch", () => {
    vi.useFakeTimers();
    const ctrl = createActivityVisibilityController();
    let hasActivity = true;

    ctrl.notifyVisible();
    ctrl.scheduleClear(() => {
      hasActivity = false;
    });

    expect(
      shouldShowOraActivityRow({
        sending: true,
        streamingWithContent: true,
        hasActivity,
      }),
    ).toBe(true);

    vi.advanceTimersByTime(ACTIVITY_MIN_SHOW_MS);

    expect(
      shouldShowOraActivityRow({
        sending: true,
        streamingWithContent: true,
        hasActivity,
      }),
    ).toBe(false);
    ctrl.dispose();
    vi.useRealTimers();
  });

  it("notifyVisible cancels an armed scheduleClear so the row stays visible", () => {
    vi.useFakeTimers();
    const ctrl = createActivityVisibilityController();
    let cleared = false;
    // Simulate real ordering: activity step shown, then first token arrives.
    ctrl.notifyVisible();
    ctrl.scheduleClear(() => {
      cleared = true;
    });
    // A second activity step arriving before the timer fires cancels the clear.
    ctrl.notifyVisible();
    vi.runAllTimers();
    expect(cleared).toBe(false);
    vi.useRealTimers();
    ctrl.dispose();
  });

  it("scheduleClear fires after ACTIVITY_MIN_SHOW_MS when not interrupted", () => {
    vi.useFakeTimers();
    const ctrl = createActivityVisibilityController();
    let cleared = false;
    // Simulate real ordering: activity step shown first, then first token arrives.
    ctrl.notifyVisible();
    ctrl.scheduleClear(() => {
      cleared = true;
    });
    vi.advanceTimersByTime(ACTIVITY_MIN_SHOW_MS - 1);
    expect(cleared).toBe(false);
    vi.advanceTimersByTime(1);
    expect(cleared).toBe(true);
    vi.useRealTimers();
    ctrl.dispose();
  });

  it("dispose cancels an armed scheduleClear so unmounted screens never call setState", () => {
    vi.useFakeTimers();
    const ctrl = createActivityVisibilityController();
    let cleared = false;
    // Simulate real ordering: activity step shown, then first token arrives.
    ctrl.notifyVisible();
    ctrl.scheduleClear(() => {
      cleared = true;
    });
    ctrl.dispose();
    vi.runAllTimers();
    expect(cleared).toBe(false);
    vi.useRealTimers();
  });
});

describe("Mobile Ora — first-token SSE ordering contract (source assertions)", () => {
  const index = read("../../app/(home)/index.tsx");

  it("uses scheduleClear (not a direct setStreamActivity null) on the first token", () => {
    // Finds the FIRST occurrence of the condition, which is the token-path guard.
    const idx = index.indexOf("if (streamedContent.length === 0) {");
    expect(idx).toBeGreaterThan(-1);
    const body = index.slice(idx, idx + 700);
    expect(body).toContain("scheduleClear(");
    // The raw direct call must not appear within the first-token branch.
    expect(body).not.toContain("setStreamActivity(null);\n");
  });

  it("pushActivity calls notifyVisible before updating state", () => {
    const pushIdx = index.indexOf("const pushActivity = useCallback(");
    expect(pushIdx).toBeGreaterThan(-1);
    const body = index.slice(pushIdx, pushIdx + 400);
    expect(body).toContain("notifyVisible()");
    // Ordering check: notifyVisible must precede the setStreamActivity updater.
    const notifyPos = body.indexOf("notifyVisible()");
    const setStatePos = body.indexOf("setStreamActivity(");
    expect(notifyPos).toBeGreaterThan(-1);
    expect(setStatePos).toBeGreaterThan(-1);
    expect(notifyPos).toBeLessThan(setStatePos);
  });

  it("keeps the footer mounted while an activity step is completing", () => {
    expect(index).toContain("shouldShowOraActivityRow({");
    expect(index).toContain("hasActivity: streamActivity !== null");
    expect(index).toContain("streamActivity?.id");
    expect(index).toContain("streamActivity?.phase");
  });
});

describe("Mobile Ora — OraThinkingRow fade lifecycle", () => {
  const row = read("../../components/ora/OraThinkingRow.tsx");

  it("fades the activity label in and out with reanimated", () => {
    expect(row).toContain("entering={FadeIn.duration(220)}");
    expect(row).toContain("exiting={FadeOut.duration(180)}");
    expect(row).toContain("<Animated.View");
    // Keyed by step id + phase so a new step (or a terminal update) remounts.
    expect(row).toContain("key={`${activity.id}:${activity.phase}`}");
  });

  it("styles failed steps distinctly while staying subtle otherwise", () => {
    expect(row).toContain('activity?.phase === "fail"');
    expect(row).toContain("c.mutedForeground");
  });
});
