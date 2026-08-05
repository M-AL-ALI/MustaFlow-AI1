import { beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  oraActivityStep,
  oraActivityText,
  oraActivityToolForRoutedTool,
  ORA_ACTIVITY_TEXT,
} from "@workspace/ora-contracts";
import {
  clearedOraActivity,
  currentOraActivityStep,
  ORA_ACTIVITY_TRACE_LIMIT,
  reduceOraActivity,
  resetOraActivityIds,
  type OraActivityTraceStep,
} from "@/lib/ora-activity";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const read = (rel: string) =>
  readFileSync(path.join(__dirname, rel), "utf8").replace(/\r\n/g, "\n");

/**
 * Ora Universal Live Activity Trace — website reducer + wiring.
 *
 * The trace is a living line, not a growing log: only the current step is
 * shown, a terminal ok/fail updates the current step in place, and the whole
 * trace clears on the first real answer token.
 */
describe("Ora activity trace — reducer", () => {
  beforeEach(() => resetOraActivityIds());

  it("shows only the current step: a new start supersedes the previous one", () => {
    let steps: OraActivityTraceStep[] = clearedOraActivity();
    steps = reduceOraActivity(steps, oraActivityStep("web-search", "start"));
    expect(currentOraActivityStep(steps)?.tool).toBe("web-search");

    steps = reduceOraActivity(steps, oraActivityStep("file-generation", "start"));
    const current = currentOraActivityStep(steps);
    expect(current?.tool).toBe("file-generation");
    expect(current?.text).toBe(ORA_ACTIVITY_TEXT["file-generation"].start);
    // The superseded step is no longer current — it only lingers as the
    // fading tail the component animates out.
    expect(steps[steps.length - 1]).toBe(current);
  });

  it("updates the in-progress step in place on its terminal ok/fail (same id)", () => {
    let steps = reduceOraActivity(clearedOraActivity(), oraActivityStep("web-search", "start"));
    const startId = currentOraActivityStep(steps)!.id;
    steps = reduceOraActivity(steps, oraActivityStep("web-search", "ok", "Found 3 sources"));
    const current = currentOraActivityStep(steps)!;
    expect(current.id).toBe(startId);
    expect(current.phase).toBe("ok");
    expect(current.text).toBe("Found 3 sources");
    expect(steps).toHaveLength(1);
  });

  it("keeps failed steps honest and distinct", () => {
    let steps = reduceOraActivity(clearedOraActivity(), oraActivityStep("web-search", "start"));
    steps = reduceOraActivity(steps, oraActivityStep("web-search", "fail"));
    expect(currentOraActivityStep(steps)?.phase).toBe("fail");
    expect(currentOraActivityStep(steps)?.text).toBe(ORA_ACTIVITY_TEXT["web-search"].fail);
  });

  it("appends a cold terminal (no matching start) as its own step", () => {
    const steps = reduceOraActivity(clearedOraActivity(), oraActivityStep("file-generation", "ok"));
    expect(steps).toHaveLength(1);
    expect(currentOraActivityStep(steps)?.phase).toBe("ok");
  });

  it("stays bounded — a living trace, not a growing log", () => {
    let steps = clearedOraActivity();
    for (let i = 0; i < 10; i++) {
      steps = reduceOraActivity(steps, oraActivityStep("repo-analysis", "start", `Step ${i}…`));
    }
    expect(steps.length).toBeLessThanOrEqual(ORA_ACTIVITY_TRACE_LIMIT);
    expect(currentOraActivityStep(steps)?.text).toBe("Step 9…");
  });

  it("clears to empty (the first-token contract)", () => {
    const populated = reduceOraActivity(
      clearedOraActivity(),
      oraActivityStep("web-search", "start"),
    );
    expect(populated).toHaveLength(1);
    const steps = clearedOraActivity();
    expect(steps).toEqual([]);
    expect(currentOraActivityStep(steps)).toBeNull();
  });

  it("never mutates the previous state", () => {
    const first = reduceOraActivity(clearedOraActivity(), oraActivityStep("web-search", "start"));
    const snapshot = JSON.parse(JSON.stringify(first)) as OraActivityTraceStep[];
    reduceOraActivity(first, oraActivityStep("web-search", "ok"));
    expect(first).toEqual(snapshot);
  });
});

describe("Ora activity trace — dataset analysis contract", () => {
  it("uses first-class shared copy and maps the routed dataset tool", () => {
    expect(oraActivityText("dataset-analysis", "start")).toBe("Analyzing your data…");
    expect(oraActivityToolForRoutedTool("dataset_analysis")).toBe("dataset-analysis");
    expect(oraActivityToolForRoutedTool("unknown_tool")).toBeNull();
  });
});

describe("Ora activity trace — hook wiring (use-ora-chat.ts)", () => {
  const hook = read("../use-ora-chat.ts");

  it("parses SSE activity events and forwards them via onActivity", () => {
    expect(hook).toContain('} else if (eventType === "activity") {');
    expect(hook).toContain("parseOraActivityStep(parsed)");
    expect(hook).toContain("if (step) onActivity?.(step);");
  });

  it("clears the trace on the FIRST answer token and ignores late activity", () => {
    const idx = hook.indexOf("let sawFirstToken = false;");
    expect(idx).toBeGreaterThan(-1);
    const body = hook.slice(idx, idx + 2200);
    expect(body).toContain("sawFirstToken = true;");
    expect(body).toContain("clearActivity();");
    expect(body).toContain("if (isTurnCurrent() && !sawFirstToken) pushActivity(step);");
  });

  it("synthesizes the start step from the specialist-tool bounce signal", () => {
    expect(hook).toContain("oraActivityToolForRoutedTool(data.tool)");
    expect(hook).toContain('onActivity?.(oraActivityStep(bouncedTool, "start"));');
  });

  it("applies server-reported terminal steps from the /chat JSON response", () => {
    expect(hook).toContain("const applyServerActivity = (d: ChatResponseData): void => {");
    expect(hook).toContain("applyServerActivity(data);");
  });

  it("narrates file and dataset reading with the shared name-aware wording", () => {
    expect(hook).toContain("ORA_ANALYZING_IMAGE_TEXT");
    expect(hook).toContain("oraAnalyzingDatasetText(currentAttachment.filename)");
    expect(hook).toContain("oraReadingFileText(currentAttachment.filename)");
    const datasetHelper = "oraAnalyzingDatasetText(currentAttachment.filename)";
    const datasetIndex = hook.indexOf(datasetHelper);
    expect(datasetIndex).toBeGreaterThan(-1);
    expect(hook.slice(datasetIndex - 120, datasetIndex + datasetHelper.length)).toContain(
      '"dataset-analysis"',
    );
    expect(hook).toContain('oraActivityStep("dataset-analysis", "ok")');
  });

  it("starts a fresh trace per turn and fails the in-flight step on errors", () => {
    expect(hook).toContain("clearActivity();");
    expect(hook).toContain("const failInFlightActivity = useCallback(() => {");
    expect(hook).toContain("failInFlightActivity();");
  });
});

describe("Ora activity trace — panel wiring (ora-panel.tsx)", () => {
  const panel = read("../../components/ora-panel.tsx");
  const trace = read("../../components/ora/ora-activity-trace.tsx");

  it("renders the animated trace in place of the static status label", () => {
    expect(panel).toContain("activitySteps.length > 0 ? (");
    expect(panel).toContain("<OraActivityTrace steps={activitySteps} />");
  });

  it("fades steps in/out and styles failures distinctly", () => {
    expect(trace).toContain("transition-all");
    expect(trace).toContain('step.phase === "fail"');
    expect(trace).toContain("text-destructive/70");
    expect(trace).toContain("text-muted-foreground");
    // Keyed by id + phase so terminal updates re-fade, and a ghost copy of the
    // outgoing step is kept briefly for its fade-out.
    expect(trace).toContain("key={`${current.id}:${current.phase}`}");
    expect(trace).toContain("setGhost");
  });
});
