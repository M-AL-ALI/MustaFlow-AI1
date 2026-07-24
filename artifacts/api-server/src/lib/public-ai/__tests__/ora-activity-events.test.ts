import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  ORA_ACTIVITY_PHASES,
  ORA_ACTIVITY_TEXT,
  ORA_ACTIVITY_TOOLS,
  oraActivityStep,
  oraActivityToolForRoutedTool,
  oraWebSearchOkText,
  parseOraActivityStep,
} from "@workspace/ora-contracts";
import {
  createOraActivityEmitter,
  withOraActivity,
  type OraActivityEmitter,
} from "../activity-events";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const read = (rel: string) =>
  readFileSync(path.join(__dirname, rel), "utf8").replace(/\r\n/g, "\n");

/**
 * Ora Universal Live Activity Trace — backend contract + emitter lifecycle.
 *
 * Guards the invariants the animated trace depends on:
 *  - every tool flow emits `start` then exactly ONE terminal `ok`/`fail`;
 *  - a forced tool failure emits `fail` and the stream still completes with
 *    an answer (tokens + done after the failure frame);
 *  - the shared wording map never leaks providers, model ids, or paths;
 *  - chat.ts wires repo narration to BOTH the legacy `status` event and the
 *    typed `activity` event, and the non-streaming fallback stays silent.
 */
describe("Ora activity events — shared contract", () => {
  it("has non-empty shared copy for every tool and phase", () => {
    for (const tool of ORA_ACTIVITY_TOOLS) {
      for (const phase of ORA_ACTIVITY_PHASES) {
        expect(ORA_ACTIVITY_TEXT[tool][phase].trim().length).toBeGreaterThan(0);
      }
    }
  });

  it("never leaks raw internals (providers, model ids, filesystem paths)", () => {
    const forbidden = /openai|gpt-|anthropic|claude|gemini|grok|xai|azure|\/home\/|\/tmp\/|node_modules|Error:/i;
    for (const tool of ORA_ACTIVITY_TOOLS) {
      for (const phase of ORA_ACTIVITY_PHASES) {
        expect(ORA_ACTIVITY_TEXT[tool][phase]).not.toMatch(forbidden);
      }
    }
  });

  it("keeps the wording style: present-continuous starts, honest failures", () => {
    for (const tool of ORA_ACTIVITY_TOOLS) {
      expect(ORA_ACTIVITY_TEXT[tool].start).toMatch(/…$/);
    }
    expect(ORA_ACTIVITY_TEXT["web-search"].fail).toContain("failed");
    expect(oraWebSearchOkText(0)).toBe(ORA_ACTIVITY_TEXT["web-search"].ok);
    expect(oraWebSearchOkText(1)).toBe("Found 1 source");
    expect(oraWebSearchOkText(5)).toBe("Found 5 sources");
  });

  it("maps the streamingFallback routed-tool ids to activity tools", () => {
    expect(oraActivityToolForRoutedTool("search")).toBe("web-search");
    expect(oraActivityToolForRoutedTool("file_generation")).toBe("file-generation");
    expect(oraActivityToolForRoutedTool("image_generation")).toBe("image-generation");
    expect(oraActivityToolForRoutedTool("image_editing")).toBe("image-generation");
    expect(oraActivityToolForRoutedTool("answer")).toBeNull();
    expect(oraActivityToolForRoutedTool(undefined)).toBeNull();
  });

  it("parseOraActivityStep accepts valid frames and rejects malformed ones", () => {
    expect(
      parseOraActivityStep({ type: "activity", tool: "web-search", phase: "start", text: "Searching the web…" }),
    ).toEqual({ tool: "web-search", phase: "start", text: "Searching the web…" });
    expect(parseOraActivityStep(null)).toBeNull();
    expect(parseOraActivityStep({ tool: "nope", phase: "start", text: "x" })).toBeNull();
    expect(parseOraActivityStep({ tool: "web-search", phase: "later", text: "x" })).toBeNull();
    expect(parseOraActivityStep({ tool: "web-search", phase: "ok", text: "" })).toBeNull();
    expect(
      parseOraActivityStep({ tool: "web-search", phase: "ok", text: "x".repeat(301) }),
    ).toBeNull();
  });
});

describe("Ora activity events — emitter lifecycle", () => {
  function collectingEmitter() {
    const wire: Array<{ type: string; tool: string; phase: string; text: string }> = [];
    const emitter = createOraActivityEmitter((ev) => wire.push(ev));
    return { wire, emitter };
  }

  it("every tool flow emits start then exactly one terminal ok", () => {
    for (const tool of ORA_ACTIVITY_TOOLS) {
      const { wire, emitter } = collectingEmitter();
      emitter.start(tool);
      emitter.ok(tool);
      emitter.ok(tool); // duplicate terminal must be ignored
      emitter.fail(tool); // terminal after close must be ignored
      expect(wire.map((e) => e.phase)).toEqual(["start", "ok"]);
      expect(wire.every((e) => e.type === "activity" && e.tool === tool)).toBe(true);
    }
  });

  it("every tool flow emits start then exactly one terminal fail", () => {
    for (const tool of ORA_ACTIVITY_TOOLS) {
      const { wire, emitter } = collectingEmitter();
      emitter.start(tool);
      emitter.fail(tool);
      emitter.fail(tool);
      emitter.ok(tool);
      expect(wire.map((e) => e.phase)).toEqual(["start", "fail"]);
    }
  });

  it("ignores a terminal for a tool that never started", () => {
    const { wire, emitter } = collectingEmitter();
    emitter.ok("web-search");
    emitter.fail("file-generation");
    expect(wire).toEqual([]);
  });

  it("allows repeated start narration (repo analysis) before one terminal", () => {
    const { wire, emitter } = collectingEmitter();
    emitter.start("repo-analysis", "Fetching owner/repo snapshot…");
    emitter.start("repo-analysis", "Reading model-router.ts…");
    emitter.start("repo-analysis", "Searching for \"quota\"…");
    emitter.ok("repo-analysis", "Analysis complete — writing up findings…");
    emitter.ok("repo-analysis");
    expect(wire.map((e) => e.phase)).toEqual(["start", "start", "start", "ok"]);
    expect(wire[1]!.text).toBe("Reading model-router.ts…");
  });

  it("defaults text to the shared copy map and honors custom text", () => {
    const { wire, emitter } = collectingEmitter();
    emitter.start("web-search");
    emitter.ok("web-search", oraWebSearchOkText(3));
    expect(wire[0]!.text).toBe(ORA_ACTIVITY_TEXT["web-search"].start);
    expect(wire[1]!.text).toBe("Found 3 sources");
  });

  it("never lets a broken write kill the caller (fire-and-forget)", () => {
    const emitter = createOraActivityEmitter(() => {
      throw new Error("socket gone");
    });
    expect(() => {
      emitter.start("web-search");
      emitter.ok("web-search");
    }).not.toThrow();
    expect(emitter.emitted().map((s) => s.phase)).toEqual(["start", "ok"]);
  });
});

describe("Ora activity events — withOraActivity wrapper", () => {
  it("emits start then ok on success and returns the tool result", async () => {
    const emitter = createOraActivityEmitter(() => {});
    const result = await withOraActivity(emitter, "web-search", async () => ({ sources: 4 }), {
      ok: (r) => oraWebSearchOkText(r.sources),
    });
    expect(result).toEqual({ sources: 4 });
    expect(emitter.emitted().map((s) => s.phase)).toEqual(["start", "ok"]);
    expect(emitter.emitted()[1]!.text).toBe("Found 4 sources");
  });

  it("emits fail on failure, then rethrows for graceful degradation", async () => {
    const emitter = createOraActivityEmitter(() => {});
    await expect(
      withOraActivity(emitter, "web-search", async () => {
        throw new Error("provider timeout");
      }),
    ).rejects.toThrow("provider timeout");
    expect(emitter.emitted().map((s) => s.phase)).toEqual(["start", "fail"]);
    expect(emitter.emitted()[1]!.text).toBe(ORA_ACTIVITY_TEXT["web-search"].fail);
  });

  it("a forced tool failure still lets the stream complete with an answer", async () => {
    // Simulated SSE wire: the tool fails mid-turn, the route catches, degrades
    // to a general-knowledge answer, and the stream still delivers tokens+done.
    const wire: Array<Record<string, unknown>> = [];
    const writeSSE = (ev: Record<string, unknown>) => wire.push(ev);
    const emitter: OraActivityEmitter = createOraActivityEmitter((ev) => writeSSE({ ...ev }));

    try {
      await withOraActivity(emitter, "web-search", async () => {
        throw new Error("search provider down");
      });
    } catch {
      // Graceful degradation: answer from own knowledge instead.
    }
    for (const token of ["It ", "still ", "answers."]) {
      writeSSE({ type: "token", text: token });
    }
    writeSSE({ type: "done", payload: { reply: "It still answers." } });

    const types = wire.map((e) => `${String(e.type)}${e.phase ? `:${String(e.phase)}` : ""}`);
    expect(types).toEqual([
      "activity:start",
      "activity:fail",
      "token",
      "token",
      "token",
      "done",
    ]);
    // Exactly one terminal, and it is honest about the failure.
    expect(wire.filter((e) => e.phase === "fail" || e.phase === "ok")).toHaveLength(1);
  });
});

describe("Ora activity events — chat route wiring", () => {
  const chat = read("../../../routes/public-ai/chat.ts");
  const analyst = read("../repo-analyst.ts");

  it("streaming route emits BOTH legacy status and typed activity for repo narration", () => {
    const onStatusIdx = chat.indexOf('onStatus: (text, phase) => {');
    expect(onStatusIdx).toBeGreaterThan(-1);
    const body = chat.slice(onStatusIdx, onStatusIdx + 400);
    expect(body).toContain('writeSSE(res, { type: "status", text })');
    expect(body).toContain('activity.ok("repo-analysis", text)');
    expect(body).toContain('activity.fail("repo-analysis", text)');
    expect(body).toContain('activity.start("repo-analysis", text)');
  });

  it("repo failures never kill the stream: catch narrates fail and continues", () => {
    expect(chat).toContain('activity.fail("repo-analysis");');
    expect(chat).toContain("ora-repo: investigation failed; continuing without repo context");
  });

  it("the non-streaming fallback still degrades silently (noop narration)", () => {
    expect(chat).toContain("onStatus: () => {}");
  });

  it("repo-analyst tags its wrap-up ok and its snapshot failure fail", () => {
    expect(analyst).toContain('args.onStatus("Analysis complete — writing up findings…", "ok")');
    expect(analyst).toContain('— answering without repo access.`, "fail")');
  });

  it("non-streaming tool paths report terminal activity with the JSON response", () => {
    // Web search: dynamic "Found N sources" on success, honest fail on degrade.
    expect(chat).toContain(
      'oraActivityStep("web-search", "ok", oraWebSearchOkText(result.sources?.length ?? 0))',
    );
    expect(chat).toContain('activity: [oraActivityStep("web-search", "fail")]');
    // File + image generation: ok with the response, fail on the error paths.
    expect(chat).toContain('activity: [oraActivityStep("file-generation", "ok")]');
    expect(chat).toContain('oraActivityStep("file-generation", "fail")');
    expect(chat).toContain('activity: [oraActivityStep("image-generation", "ok")]');
    expect(chat).toContain('oraActivityStep("image-generation", "fail")');
  });

  it("the streamed false-delivery rescue narrates file generation start/ok/fail", () => {
    expect(chat).toContain('params.activity?.start("file-generation")');
    expect(chat).toContain('params.activity?.ok("file-generation")');
    expect(chat).toContain('params.activity?.fail("file-generation")');
  });

  it("helper defaults keep the branded voice for ad-hoc steps", () => {
    expect(oraActivityStep("image-generation", "start").text).toBe("Creating your image…");
    expect(oraActivityStep("file-reading", "fail").text).toBe(
      ORA_ACTIVITY_TEXT["file-reading"].fail,
    );
    expect(oraActivityStep("web-search", "ok", "  ").text).toBe(ORA_ACTIVITY_TEXT["web-search"].ok);
  });
});
