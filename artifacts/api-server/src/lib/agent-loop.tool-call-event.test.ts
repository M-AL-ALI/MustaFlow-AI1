import { describe, it, expect } from "vitest";

vi.mock("@workspace/db", () => ({
  db: {},
  toolAuditTable: {},
  builderSkillsTable: {},
}));

vi.mock("drizzle-orm", () => ({
  sql: () => ({}),
  inArray: () => ({}),
  eq: () => ({}),
  and: () => ({}),
}));

import { vi } from "vitest";
import {
  TOOL_CALL_DEDICATED_EVENTS,
  shouldEmitToolCallEvent,
  buildToolCallEventPayload,
} from "./agent-loop";

describe("Task #743 — tool_call event emission", () => {
  describe("shouldEmitToolCallEvent", () => {
    it("emits for tools without a dedicated event type", () => {
      expect(shouldEmitToolCallEvent("web_search")).toBe(true);
      expect(shouldEmitToolCallEvent("take_screenshot")).toBe(true);
      expect(shouldEmitToolCallEvent("read_diagnostics")).toBe(true);
      expect(shouldEmitToolCallEvent("read_file")).toBe(true);
      expect(shouldEmitToolCallEvent("list_files")).toBe(true);
      expect(shouldEmitToolCallEvent("semantic_search")).toBe(true);
    });

    it("skips file mutation tools (covered by file_diff)", () => {
      expect(shouldEmitToolCallEvent("write_file")).toBe(false);
      expect(shouldEmitToolCallEvent("apply_patch")).toBe(false);
      expect(shouldEmitToolCallEvent("delete_file")).toBe(false);
    });

    it("skips run_command (covered by command_output)", () => {
      expect(shouldEmitToolCallEvent("run_command")).toBe(false);
    });

    it("skips creative tools (covered by creative-preview events)", () => {
      expect(shouldEmitToolCallEvent("generate_image")).toBe(false);
      expect(shouldEmitToolCallEvent("generate_video")).toBe(false);
      expect(shouldEmitToolCallEvent("generate_audio")).toBe(false);
      expect(shouldEmitToolCallEvent("remove_image_background")).toBe(false);
    });

    it("skips control-flow tools (report_progress / finalize)", () => {
      expect(shouldEmitToolCallEvent("report_progress")).toBe(false);
      expect(shouldEmitToolCallEvent("finalize")).toBe(false);
    });

    it("dedicated set is a frozen-ish ReadonlySet", () => {
      expect(TOOL_CALL_DEDICATED_EVENTS.has("write_file")).toBe(true);
      expect(TOOL_CALL_DEDICATED_EVENTS.has("read_file")).toBe(false);
    });
  });

  describe("buildToolCallEventPayload", () => {
    it("carries { tool, args, ok, durationMs, preview }", () => {
      const payload = buildToolCallEventPayload(
        "web_search",
        { query: "react query cache invalidation", limit: 5 },
        true,
        123,
        "Found 5 results matching the query…",
      );
      expect(payload).toEqual({
        tool: "web_search",
        args: { query: "react query cache invalidation", limit: 5 },
        ok: true,
        durationMs: 123,
        preview: "Found 5 results matching the query…",
      });
    });

    it("truncates the preview at 400 chars", () => {
      const long = "x".repeat(2000);
      const payload = buildToolCallEventPayload("read_file", { path: "a" }, true, 1, long);
      expect(payload.preview.length).toBe(400);
      expect(payload.preview).toBe("x".repeat(400));
    });

    it("truncates large string args to ~200 chars each", () => {
      const huge = "y".repeat(5000);
      const payload = buildToolCallEventPayload("search", { query: huge }, true, 10, "ok");
      const q = payload.args.query as string;
      expect(q.length).toBeLessThanOrEqual(201); // 200 chars + ellipsis
      expect(q.endsWith("…")).toBe(true);
    });

    it("preserves booleans and numbers verbatim", () => {
      const payload = buildToolCallEventPayload(
        "semantic_search",
        { query: "q", top_k: 8, include_drafts: false },
        true,
        50,
        "snippet",
      );
      expect(payload.args).toMatchObject({ query: "q", top_k: 8, include_drafts: false });
    });

    it("reports ok=false for failed tool runs", () => {
      const payload = buildToolCallEventPayload(
        "read_file",
        { path: "missing.txt" },
        false,
        4,
        "ERROR: file not found",
      );
      expect(payload.ok).toBe(false);
      expect(payload.preview).toContain("ERROR");
    });

    it("survives non-string observation values without throwing", () => {
      const payload = buildToolCallEventPayload(
        "list_files",
        {},
        true,
        2,
        // @ts-expect-error — defensive: runtime sometimes hands us objects
        { not: "a string" },
      );
      expect(payload.preview).toBe("");
    });

    it("returns a JSON-serializable shape", () => {
      const payload = buildToolCallEventPayload(
        "web_fetch",
        { url: "https://example.com" },
        true,
        77,
        "<html>…</html>",
      );
      const round = JSON.parse(JSON.stringify(payload));
      expect(round).toEqual(payload);
    });
  });
});
