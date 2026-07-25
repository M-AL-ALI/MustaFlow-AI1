import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  ORA_ACTIVITY_TEXT,
  ORA_REALTIME_RECONNECT_BACKOFF_MS,
  ORA_REALTIME_RECONNECT_MAX_ATTEMPTS,
  ORA_REALTIME_TOOL_NARRATION_PURPOSE,
  ORA_REALTIME_TOOL_NAMES,
  buildOraRealtimeToolNarrationEvent,
  parseOraRealtimeFunctionCallEvent,
  parseOraRealtimeToolNarrationCallId,
  type OraRealtimeToolName,
} from "@workspace/ora-contracts";
import type { OraRealtimeToolExecutionContext, OraRealtimeToolExecutors } from "../realtime-tools";

process.env.DATABASE_URL ??= "postgresql://placeholder:placeholder@127.0.0.1:5432/placeholder";
process.env.AI_INTEGRATIONS_OPENAI_BASE_URL ??= "http://127.0.0.1:9/v1";
process.env.AI_INTEGRATIONS_OPENAI_API_KEY ??= "test-placeholder";

const { ORA_REALTIME_TOOL_DEFINITIONS, executeOraRealtimeFunctionCall, realtimeToolActivity } =
  await import("../realtime-tools");

const CONTEXT: OraRealtimeToolExecutionContext = {
  userId: null,
  tier: "anonymous",
  oraSessionId: "test-session",
};

function executors(
  selected: OraRealtimeToolName,
  implementation: OraRealtimeToolExecutors[OraRealtimeToolName],
): OraRealtimeToolExecutors {
  return Object.fromEntries(
    ORA_REALTIME_TOOL_NAMES.map((name) => [
      name,
      name === selected ? implementation : vi.fn(async () => ({ output: `unused ${name}` })),
    ]),
  ) as OraRealtimeToolExecutors;
}

beforeEach(() => {
  delete process.env.ORA_DISABLED;
  delete process.env.ORA_WEB_SEARCH_DISABLED;
  delete process.env.ORA_FILE_GENERATION_DISABLED;
  delete process.env.ORA_IMAGE_GENERATION_DISABLED;
});

describe("Ora realtime tool surface", () => {
  it("contains exactly the intended tools and only the five read-only GitHub tools", () => {
    expect(ORA_REALTIME_TOOL_DEFINITIONS.map((tool) => tool.name)).toEqual([
      ...ORA_REALTIME_TOOL_NAMES,
    ]);

    const repoNames = ORA_REALTIME_TOOL_DEFINITIONS.map((tool) => tool.name).filter((name) =>
      ["list_files", "read_file", "search_repo", "read_commits", "diff"].includes(name),
    );
    expect(repoNames.sort()).toEqual(
      ["diff", "list_files", "read_commits", "read_file", "search_repo"].sort(),
    );
    expect(repoNames.join(" ")).not.toMatch(
      /\b(?:write_file|commit_change|push|create_pr|mutate|delete_file|apply_patch)\b/i,
    );
  });

  it("leaves narration to the deterministic client protocol without duplicate preambles", () => {
    for (const definition of ORA_REALTIME_TOOL_DEFINITIONS) {
      expect(realtimeToolActivity(definition.name)).toBeTruthy();
      expect(definition.description).toContain("activity automatically");
      expect(definition.description).not.toContain(
        ORA_ACTIVITY_TEXT[realtimeToolActivity(definition.name)].start,
      );
      expect(definition.parameters).toMatchObject({
        type: "object",
        additionalProperties: false,
      });
    }
  });

  it("keeps the web and mobile recovery policy in one shared contract", () => {
    expect(ORA_REALTIME_RECONNECT_BACKOFF_MS).toEqual([2_000, 5_000, 10_000]);
    expect(ORA_REALTIME_RECONNECT_MAX_ATTEMPTS).toBe(6);
  });

  it("keeps voice file revisions on the same durable lineage contract as text Ora", async () => {
    const source = await readFile(
      fileURLToPath(new URL("../realtime-tools.ts", import.meta.url)),
      "utf8",
    );

    expect(source).toContain("getNextVersionLineageFromAssetId(context.userId, active.assetId)");
    expect(source).toContain("getNextVersionLineage(context.userId, result.editedFileRef)");
    expect(source).toContain("result.editQuality.versionId = assetId");
    expect(source).toContain("relinkDurableFileContextBestEffort");
    expect(source).toContain("planOraMultiFile");
    expect(source).toContain("multiFilePlan?.targetFileRef");
    expect(source).toContain('editMode: "redesigned"');
    expect(source).toContain("usedFiles: multiFilePlan.usedFiles");
  });
});

describe("Ora realtime function-call protocol", () => {
  it("builds deterministic out-of-band audio narration from shared activity copy", () => {
    const event = buildOraRealtimeToolNarrationEvent("call_search", "web_search");

    expect(event).toMatchObject({
      type: "response.create",
      response: {
        conversation: "none",
        output_modalities: ["audio"],
        tools: [],
        tool_choice: "none",
        metadata: {
          purpose: ORA_REALTIME_TOOL_NARRATION_PURPOSE,
          tool_call_id: "call_search",
        },
      },
    });
    expect(JSON.stringify(event)).toContain(ORA_ACTIVITY_TEXT["web-search"].start);
    expect(
      parseOraRealtimeToolNarrationCallId({
        type: "response.done",
        response: {
          metadata: {
            purpose: ORA_REALTIME_TOOL_NARRATION_PURPOSE,
            tool_call_id: "call_search",
          },
        },
      }),
    ).toBe("call_search");
    expect(parseOraRealtimeToolNarrationCallId({ type: "response.done", response: {} })).toBeNull();
  });

  it("normalizes every supported completion event, including response.done", () => {
    const expected = {
      callId: "call_123",
      name: "web_search",
      argumentsJson: '{"query":"latest release"}',
    };

    expect(
      parseOraRealtimeFunctionCallEvent({
        type: "response.function_call_arguments.done",
        call_id: "call_123",
        name: "web_search",
        arguments: '{"query":"latest release"}',
      }),
    ).toEqual(expected);
    expect(
      parseOraRealtimeFunctionCallEvent({
        type: "response.output_item.done",
        item: {
          type: "function_call",
          call_id: "call_123",
          name: "web_search",
          arguments: '{"query":"latest release"}',
        },
      }),
    ).toEqual(expected);
    expect(
      parseOraRealtimeFunctionCallEvent({
        type: "response.done",
        response: {
          output: [
            {
              type: "function_call",
              call_id: "call_123",
              name: "web_search",
              arguments: '{"query":"latest release"}',
            },
          ],
        },
      }),
    ).toEqual(expected);
  });

  it("rejects unknown or malformed function calls without throwing", () => {
    expect(
      parseOraRealtimeFunctionCallEvent({
        type: "response.output_item.done",
        item: { type: "function_call", call_id: "call_1", name: "push" },
      }),
    ).toBeNull();
    expect(parseOraRealtimeFunctionCallEvent({ type: "response.done", response: {} })).toBeNull();
  });

  it("executes a simulated function call and returns rich written output", async () => {
    const execute = vi.fn(async (args: Record<string, unknown>) => ({
      output: `Verified: ${String(args.query)}`,
      writtenResult: {
        content: "Verified current information.",
        sources: [{ title: "Source", url: "https://example.com" }],
        usedFiles: [{ name: "budget.xlsx", role: "source_data" as const }],
      },
    }));

    const result = await executeOraRealtimeFunctionCall(
      {
        callId: "call_search",
        name: "web_search",
        argumentsJson: '{"query":"current status"}',
      },
      CONTEXT,
      executors("web_search", execute),
    );

    expect(execute).toHaveBeenCalledWith({ query: "current status" }, CONTEXT);
    expect(result).toMatchObject({
      ok: true,
      output: "Verified: current status",
      recoverable: true,
      activity: { tool: "web-search", phase: "ok" },
      writtenResult: {
        content: "Verified current information.",
        usedFiles: [{ name: "budget.xlsx", role: "source_data" }],
      },
    });
  });

  it("turns a forced tool failure into a spoken-safe result and keeps the session recoverable", async () => {
    const execute = vi.fn(async () => {
      throw new Error(
        "provider model failed at C:\\Users\\runner\\secret\\tool.ts /home/runner/private",
      );
    });

    const result = await executeOraRealtimeFunctionCall(
      {
        callId: "call_repo",
        name: "analyze_repo",
        argumentsJson: '{"question":"find bugs"}',
      },
      CONTEXT,
      executors("analyze_repo", execute),
    );

    expect(result.ok).toBe(false);
    expect(result.recoverable).toBe(true);
    expect(result.activity).toMatchObject({ tool: "repo-analysis", phase: "fail" });
    expect(result.output).toBe(ORA_ACTIVITY_TEXT["repo-analysis"].fail);
    expect(result.output).not.toMatch(/provider|model|stack|[A-Za-z]:\\|\/home\//i);
  });
});
