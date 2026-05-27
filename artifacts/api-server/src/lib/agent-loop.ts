/**
 * Agentic builder loop — Replit-Agent-style tool calling.
 *
 * Replaces the single-shot JSON-mode prompt with an iterative model loop that
 * picks tools (read_file, write_file, list_files, search, run_command,
 * apply_patch, report_progress, finalize), observes results, and continues
 * until the configured checks pass or a safety limit is hit.
 *
 * Modes:
 *   - In-process (static-html, mobile-cross): tool calls operate on an
 *     in-memory file map; `run_command` only runs the in-process validators
 *     declared in CHECK_PROFILES — there is no shell.
 *   - Container (react-vite, node-api, nextjs, python-flask, python-fastapi):
 *     tool calls are routed to the project's Fly.io container via
 *     execInContainer / writeFileToContainer / syncFilesToContainer.
 *
 * Safety:
 *   - Step cap (default 25), wall-clock budget (8 min), repeated-error cap (3).
 *   - run_command argv whitelist + path sanitization (sandboxed to /app).
 *   - Honours the per-task AbortController passed in from runJob.
 *
 * Credits: charged once per build by runJob — this loop never deducts credits
 * itself.
 */

import { openai } from "@workspace/integrations-openai-ai-server";
import { z } from "zod";
import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
  ChatCompletionMessageToolCall,
} from "openai/resources/chat/completions";
import type { AgentMode } from "./ai";
import type { BuilderFile, BuilderResult, Blueprint, ConversationTurn } from "./builder";
import type { TaskReport, E2eRunSummary, E2eScenarioResult } from "@workspace/db";
import {
  runE2eScenarios,
  runUserSpecs,
  defaultSmokeScenarios,
  discoverUserSpecs,
  type E2eScenario,
} from "./checks/e2e-runner";
import { logger } from "./logger";
import { CHECK_PROFILES, resolveStackId, type CheckSpec, type StackId } from "./check-profiles";
import {
  DEFAULT_POLICY_STRICTNESS,
  PER_CALL_STDOUT_CAP,
  PER_CALL_TIMEOUT_CAP_MS,
  PER_CALL_TIMEOUT_DEFAULT_MS,
  PKG_INSTALL_TIMEOUT_MS,
  evaluatePkgInstall,
  evaluateRunCommand,
  isPolicyStrictness,
  type PolicyStrictness,
} from "./policy";
import { db, toolAuditTable } from "@workspace/db";
import {
  listEnabledSkills,
  loadSkillContent,
  formatSkillIndex,
  authorSkillDraft,
  type SkillManifest,
} from "./builder-skills";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type AgentLoopMode = "build" | "refine";

export type AgentLoopEvent = (eventType: string, message: string) => Promise<void> | void;

export interface AgentLoopInput {
  mode: AgentLoopMode;
  projectId: number;
  projectName: string;
  projectKind: string;
  projectFormat: string | null;
  stack: string | null;
  userPrompt: string;
  agentMode: AgentMode;
  conversationHistory?: ConversationTurn[];
  knowledgeContext?: string;
  planContext?: Record<string, unknown> | null;
  /** Existing files (refine) or seed files (build, usually empty). */
  existingFiles: BuilderFile[];
  /** Fly.io machine id, when the project has a provisioned container. */
  containerId?: string | null;
  /** Project policy strictness (safe|standard|permissive). Defaults to "standard". */
  policyStrictness?: PolicyStrictness | null;
  /** Owning task id — used to tag audit rows. */
  taskId?: number | null;
  /**
   * Per-run wall-clock cap (ms). Overrides the global AGENTIC_BUILDER_WALL_CLOCK_MS
   * default — used by background jobs which run longer than foreground ones.
   * Clamped to [60_000, 30 * 60_000].
   */
  wallClockMs?: number;
  /** Live preview URL for the project (container proxy or static preview). Used for E2E. */
  previewUrl?: string | null;
  /** Per-project Playwright E2E enablement. Defaults true. */
  e2eEnabled?: boolean;
  /**
   * Surface that owns this project: 'builder' = AI Build Mode (default),
   * 'developer' = Developer Mode cloud IDE.  When 'developer', the agent
   * knows every project runs as a live server process in a Linux container
   * and must never generate raw static-HTML-only output.
   */
  projectMode?: string | null;
  onEvent: AgentLoopEvent;
  signal: AbortSignal;
  /**
   * When true, the agent loop pauses before executing any run_command or
   * pkg_install call and emits a blocking approval prompt to the user.
   * On rejection the model receives a clear error and must find an alternative.
   * Default false — fully autonomous (existing behaviour).
   */
  requireCommandApproval?: boolean;
  /**
   * Optional billing hook: invoked when a billable batch of web-sense calls
   * (web_fetch + web_search + extract_branding) completes (every 5 calls).
   * Charged in-loop so the user pays for usage even on cancel/failure paths,
   * not only on successful task completion. Receives the credit cost to
   * deduct for THIS batch (always 1 in current pricing).
   */
  onBillableSenseBatch?: (credits: number, totalWebCalls: number) => void;
  /**
   * Optional billing hook (Task #530 "Agent Creative Pack"): invoked after
   * every successful media-generation tool call. Receives the credit cost
   * for THIS call (image=1, video=3, audio=2, bgRemoval=1) and the tool
   * name. Charged in-loop so usage is metered even on cancel/failure paths
   * (only successful calls bill — failed calls return an error without
   * charging).
   */
  onBillableCreativeCall?: (
    credits: number,
    tool: "generate_image" | "generate_video" | "generate_audio" | "remove_image_background",
  ) => void;
}

export type ToolCallRecord = {
  step: number;
  tool: string;
  args: Record<string, unknown>;
  ok: boolean;
  durationMs: number;
  /** First ~400 chars of the observation returned to the model. */
  preview: string;
};

export type CommandRecord = {
  step: number;
  argv: string[];
  exitCode: number;
  durationMs: number;
  stdoutPreview: string;
  stderrPreview: string;
};

export type CheckResultRecord = {
  id: string;
  label: string;
  passed: boolean;
  durationMs: number;
  message: string;
};

export type AgentLoopReport = {
  stack: StackId;
  steps: number;
  totalToolCalls: number;
  totalTokens: number;
  terminationReason:
    | "finalized"
    | "step-cap"
    | "wall-clock"
    | "repeated-error"
    | "model-stopped"
    | "aborted"
    | "checks-failed";
  toolCalls: ToolCallRecord[];
  commandsRun: CommandRecord[];
  checkResults: CheckResultRecord[];
  /** Skill names the model invoked `load_skill` for during this run. */
  skillsLoaded: string[];
  e2eResults?: E2eRunSummary | null;
  /** Counts of "agent senses" tool invocations (Task #529). */
  senseCalls?: {
    screenshot: number;
    webFetch: number;
    webSearch: number;
    branding: number;
    diagnostics: number;
  };
  /** Counts of "agent creative pack" tool invocations (Task #530). */
  creativeCalls?: {
    image: number;
    video: number;
    audio: number;
    bgRemoval: number;
  };
  /**
   * Task #531: assets the agent surfaced via `present_asset`. Lifted from the
   * loop's `presentedAssets` accumulator and forwarded into `TaskReport.assets`
   * by the build/refine adapters.
   */
  assets?: Array<{
    path: string;
    name: string;
    sizeBytes: number;
    mimeType: string;
    description?: string;
  }>;
};

export type AgentLoopResult = {
  files: BuilderFile[];
  changedFiles: BuilderFile[];
  removedPaths: string[];
  unchangedFiles: string[];
  assistantSummary: string;
  warnings: string[];
  loopReport: AgentLoopReport;
  /** True when any required check failed and the agent could not recover. */
  checksFailed: boolean;
};

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const STEP_CAP = Math.max(5, parseInt(process.env.AGENTIC_BUILDER_STEP_CAP ?? "25", 10));
const WALL_CLOCK_MS = Math.max(
  60_000,
  parseInt(process.env.AGENTIC_BUILDER_WALL_CLOCK_MS ?? "480000", 10),
);
const REPEATED_ERROR_CAP = 3;
const MAX_OBSERVATION_CHARS = PER_CALL_STDOUT_CAP;
const MAX_FILE_BYTES = 64_000;

const MODEL_FOR_MODE: Record<AgentMode, string> = {
  lite: "gpt-5-nano",
  eco: "gpt-5-mini",
  power: "gpt-5.4",
  pro: "gpt-5.4",
};

// ─────────────────────────────────────────────────────────────────────────────
// Path sanitization & command checks
// ─────────────────────────────────────────────────────────────────────────────

export function sanitizePath(rawPath: unknown): string | null {
  if (typeof rawPath !== "string") return null;
  const trimmed = rawPath.trim().replace(/^\.?\/+/, "");
  if (trimmed.length === 0 || trimmed.length > 512) return null;
  if (trimmed.includes("..")) return null;
  if (trimmed.startsWith("/")) return null;
  if (/[\u0000-\u001f]/.test(trimmed)) return null;
  // Reject shell metacharacters: $, backtick, |, &, ;, <, >, parens, quotes, *, ?, [, ], {, }, \, newlines.
  // Defence-in-depth — these paths should never reach a shell, but if they do
  // (e.g. via a future helper), this prevents command substitution / glob abuse.
  if (/[$`|&;<>()'"*?[\]{}\\\n\r]/.test(trimmed)) return null;
  return trimmed;
}

/**
 * Back-compat shim — older call sites and tests import `isCommandAllowed`.
 * Delegates to the policy module, using the default "standard" strictness.
 * New code should call `evaluateRunCommand` from ./policy directly with the
 * project's configured strictness.
 */
export function isCommandAllowed(
  argv: string[],
  policy: {
    allowedExactArgvs: string[][];
    installCmd: string[] | null;
  },
): { ok: boolean; reason?: string } {
  const r = evaluateRunCommand(argv, DEFAULT_POLICY_STRICTNESS, policy);
  return r.ok ? { ok: true } : { ok: false, reason: r.reason };
}

// ─────────────────────────────────────────────────────────────────────────────
// In-process validators (for static-html + mobile-cross)
// ─────────────────────────────────────────────────────────────────────────────

function runInprocessValidator(
  kind: string,
  files: BuilderFile[],
): { exitCode: number; output: string } {
  if (kind === "html-syntax") {
    const issues: string[] = [];
    let hasIndex = false;
    for (const f of files) {
      if (f.path === "index.html") hasIndex = true;
      if (f.path.endsWith(".html")) {
        const c = f.content;
        const openTags = (c.match(/<html[\s>]/gi) ?? []).length;
        const closeTags = (c.match(/<\/html>/gi) ?? []).length;
        if (openTags !== closeTags) issues.push(`${f.path}: unbalanced <html> tags`);
        if (!/<head[\s>]/i.test(c)) issues.push(`${f.path}: missing <head>`);
        if (!/<body[\s>]/i.test(c)) issues.push(`${f.path}: missing <body>`);
      }
    }
    if (!hasIndex && files.length > 0) issues.push("missing index.html");
    return {
      exitCode: issues.length === 0 ? 0 : 1,
      output: issues.length === 0 ? "html-syntax: ok" : issues.join("\n"),
    };
  }
  if (kind === "cross-file") {
    const paths = new Set(files.map((f) => f.path));
    const issues: string[] = [];
    for (const f of files) {
      if (!f.path.endsWith(".html")) continue;
      const hrefs = Array.from(f.content.matchAll(/href=["']\.\/([^"'#?]+)["']/gi));
      for (const m of hrefs) {
        const target = m[1] ?? "";
        if (target.endsWith(".html") && !paths.has(target)) {
          issues.push(`${f.path}: broken link → ${target}`);
        }
      }
    }
    return {
      exitCode: issues.length === 0 ? 0 : 1,
      output: issues.length === 0 ? "cross-file: ok" : issues.join("\n"),
    };
  }
  if (kind === "mobile-structure") {
    const required = ["app.json", "app/_layout.tsx", "app/index.tsx"];
    const have = new Set(files.map((f) => f.path));
    const missing = required.filter((p) => !have.has(p));
    return {
      exitCode: missing.length === 0 ? 0 : 1,
      output:
        missing.length === 0
          ? "mobile-structure: ok"
          : `missing required files: ${missing.join(", ")}`,
    };
  }
  return { exitCode: 1, output: `unknown inprocess validator: ${kind}` };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool catalog (OpenAI schema)
// ─────────────────────────────────────────────────────────────────────────────

export const TOOLS: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "list_uploads",
      description:
        "List user-uploaded files attached to this project (drag-drop uploads, NOT project source files). Returns { uploads: [{ id, filename, mimeType, sizeBytes, hasTextPreview }] }. Use this to discover what reference material (CSVs, PDFs, docs) the user has provided. Use `read_upload` to fetch the textual preview of an upload.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "read_inbox",
      description:
        "Read user feedback items submitted via the Feedback button in this project. Returns { items: [{ id, category, severity, description, screenshotUrl, status, createdAt }] }. By default returns only unread items so you can address fresh feedback. Pass include_read=true to also return previously-read items. Items returned by this call are automatically marked as read so the user does not see them again in your next build.",
      parameters: {
        type: "object",
        properties: {
          include_read: {
            type: "boolean",
            description: "If true, include items already marked read (but not resolved).",
          },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_upload",
      description:
        "Read the text preview of a user-uploaded file by id (returned by list_uploads). Returns the first ~8 KB of UTF-8 text for textlike files (CSV, JSON, plain text, markdown). For binary uploads (PDF, images, video) returns a short metadata-only summary. Use this to ground generated code in user-supplied data.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "integer", description: "Upload id from list_uploads." },
        },
        required: ["id"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_files",
      description:
        "List paths of files currently in the project (relative to project root). Returns a flat array of strings.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description:
        "Read text content of one project file. Supports pagination for large files via `offset` (1-indexed start line, default 1) and `limit` (max lines to return, default whole file). When the file is truncated, the response is prefixed with `[showing lines X–Y of N]` so you know to request more.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Relative path inside the project." },
          offset: {
            type: "integer",
            description: "1-indexed start line. Default 1.",
          },
          limit: {
            type: "integer",
            description: "Max number of lines to return from `offset`. Default: whole file.",
          },
        },
        required: ["path"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description:
        "Create or overwrite a project file with full new content. Use this for both new files and full rewrites.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          content: { type: "string" },
          mime_type: {
            type: "string",
            description: "Optional, inferred from extension if absent.",
          },
        },
        required: ["path", "content"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "apply_patch",
      description:
        "Replace an exact substring in a file. Use this for small targeted edits to large files. Fails if old_text appears zero or multiple times.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          old_text: { type: "string" },
          new_text: { type: "string" },
        },
        required: ["path", "old_text", "new_text"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "delete_file",
      description: "Remove a file from the project.",
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search",
      description:
        'Case-insensitive substring search across all current project files. Returns up to 50 matching lines with file:line prefix. For natural-language intent queries (e.g. "where is the cart logic?") prefer `semantic_search`.',
      parameters: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "semantic_search",
      description:
        'Find the top-k most semantically relevant project files for a natural-language query (e.g. "checkout flow", "auth middleware"). Returns ranked paths with similarity scores and a short snippet. Uses per-project embeddings (text-embedding-3-small), built lazily on first call and refreshed on file changes. Falls back to substring ranking if embeddings are unavailable.',
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Natural-language intent (1-400 chars)." },
          top_k: {
            type: "integer",
            description: "Number of results to return (1-20, default 8).",
          },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "find_files",
      description:
        "List project file paths that match a glob pattern. Supports `*` (single segment), `?` (one char), and `**` (any depth). Examples: `src/**/*.ts`, `*.json`, `app/**/page.tsx`. Returns matching paths sorted most-recently-modified first (tiebreak alphabetical).",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Glob pattern, relative to project root." },
        },
        required: ["pattern"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run_command",
      description:
        "Run a shell command inside the project's container (or an in-process validator for static-html / mobile projects). Pass argv as an array; avoid shell metacharacters (;, &, |, redirects, backticks, $()). Destructive ops, raw network tools (curl/wget/nc/ssh), and inline code-eval flags are blocked by policy. For installing dependencies, use `pkg_install` instead — it is faster, structured, and surfaces version conflicts cleanly. Returns combined stdout+stderr (truncated).",
      parameters: {
        type: "object",
        properties: {
          argv: {
            type: "array",
            items: { type: "string" },
            description: 'argv array, e.g. ["sh","-lc","npx --yes tsc --noEmit"].',
          },
          timeout_ms: { type: "integer" },
        },
        required: ["argv"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "pkg_install",
      description:
        "Install a package into the project. Use this instead of running raw npm/pip via run_command — it is structured, validated, and audited. Manager picks the registry: npm/pnpm/yarn use the npm registry, pip uses PyPI.",
      parameters: {
        type: "object",
        properties: {
          manager: {
            type: "string",
            enum: ["npm", "pnpm", "yarn", "pip"],
          },
          pkg: {
            type: "string",
            description: 'Package name (e.g. "zod", "@types/node", "fastapi").',
          },
          version: {
            type: "string",
            description:
              'Optional version spec. npm/pnpm/yarn: semver range like "^3.22.0" or "latest". pip: PEP 440 spec like "2.5.0" or ">=1.0,<2".',
          },
        },
        required: ["manager", "pkg"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run_e2e",
      description:
        "Run Playwright end-to-end scenarios against the project's live preview URL. Captures pass/fail, console errors, network failures, and a screenshot on failure. If `scenarios` is omitted, the default smoke set (page loads, no console errors, primary button clickable) is used. Budget: 60s total, 10 scenarios max, 5MB screenshots max — enforced by the runner.",
      parameters: {
        type: "object",
        properties: {
          scenarios: {
            type: "array",
            description: "Optional list of scenarios. Omit to use the smoke defaults.",
            items: {
              type: "object",
              properties: {
                name: { type: "string" },
                steps: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      action: {
                        type: "string",
                        enum: [
                          "click",
                          "fill",
                          "expectVisible",
                          "expectText",
                          "waitFor",
                          "noConsoleErrors",
                        ],
                      },
                      selector: { type: "string" },
                      value: { type: "string" },
                      timeoutMs: { type: "integer" },
                      optional: { type: "boolean" },
                    },
                    required: ["action"],
                    additionalProperties: false,
                  },
                },
              },
              required: ["name", "steps"],
              additionalProperties: false,
            },
          },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run_workflow",
      description:
        "Run a named workflow declared in the project's workflows.yaml (or one of the per-stack defaults). Lets you start dev servers, run tests, build, etc. without re-typing the command. Returns combined stdout+stderr.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Workflow name as declared in workflows.yaml." },
          timeout_ms: { type: "integer" },
        },
        required: ["name"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "report_progress",
      description:
        "Emit a short narrative step shown in the chat (one short sentence). Use sparingly between major actions.",
      parameters: {
        type: "object",
        properties: { message: { type: "string" } },
        required: ["message"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "fetch_prod_logs",
      description:
        "Fetch recent production logs and grouped errors from the live published snapshot of this project. Use when the user reports the deployed app is broken, asks why it's failing, or before refining a published project. Returns at most 20 raw rows plus the top 10 grouped errors.",
      parameters: {
        type: "object",
        properties: {
          kind: {
            type: "string",
            enum: ["request", "browser", "server", "all"],
            description: "Filter by log kind. Default: 'all'.",
          },
          limit: {
            type: "integer",
            description: "Max raw log rows to return (1-50). Default 20.",
          },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "take_screenshot",
      description:
        "Capture a PNG screenshot of the project's live preview URL (or any http(s) URL). Use to visually verify layout, before/after refactors, or design feedback. Shares a 5MB per-task screenshot budget with run_e2e — exceeding the budget returns an error.",
      parameters: {
        type: "object",
        properties: {
          url: {
            type: "string",
            description:
              "URL to capture. Omit to screenshot the project's own preview URL when one is available.",
          },
          width: { type: "integer", description: "Viewport width (default 1280, max 1920)." },
          height: { type: "integer", description: "Viewport height (default 800, max 1200)." },
          full_page: { type: "boolean", description: "Capture the full scrollable page." },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "web_fetch",
      description:
        "Fetch an http(s) URL and return cleaned text/markdown. HTML is parsed (scripts/styles stripped). Use for reading docs, API references, or any external page. Response capped at 6,000 chars. Costs 1 credit per 5 calls (combined across web_fetch / web_search / extract_branding).",
      parameters: {
        type: "object",
        properties: { url: { type: "string" } },
        required: ["url"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "web_search",
      description:
        "Search the web via Brave Search. Returns up to 10 hits with title/url/snippet. Use for current information (library versions, error messages, design references) you cannot infer from project files. Requires BRAVE_SEARCH_API_KEY — returns a structured 'not configured' error if absent.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string" },
          limit: { type: "integer", description: "Max hits (1-10, default 5)." },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "extract_branding",
      description:
        "Extract brand signals from a website: title, theme color, primary colors, fonts (Google Fonts + inline font-family), favicon, og:image. Use when the user references a brand URL ('match acme.com') or you need design tokens for a redesign.",
      parameters: {
        type: "object",
        properties: { url: { type: "string" } },
        required: ["url"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_diagnostics",
      description:
        "Run a fast language-aware diagnostic probe (tsc/node --check/python -m py_compile) for a single file and return structured diagnostics (file/line/severity/message). Faster than running the full per-stack check profile. Requires the project container to be available; falls back to an error if not.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Project file path inside the container." },
          tool: {
            type: "string",
            enum: ["tsc", "node", "python", "eslint", "auto"],
            description:
              "Diagnostic tool; defaults to auto from extension. Use 'eslint' for lint diagnostics. `path` may be a glob (e.g. 'src/**/*.ts').",
          },
        },
        required: ["path"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "generate_image",
      description:
        "Generate a PNG image from a text prompt via gpt-image-1. Writes the result into the project at the given path (must end in .png). Use for app icons, hero illustrations, placeholder photography, generated logos. Costs 1 credit per call. Total combined creative-pack budget is 5 calls per task.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Project-relative output path ending in .png (e.g. 'assets/hero.png').",
          },
          prompt: { type: "string", description: "Detailed description of the image to generate." },
          size: {
            type: "string",
            enum: ["256x256", "512x512", "1024x1024"],
            description: "Output resolution; defaults to 1024x1024.",
          },
        },
        required: ["path", "prompt"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "generate_video",
      description:
        "Generate a short MP4 video clip (2-8s) from a text prompt. Routes to the provider configured by VIDEO_GENERATION_PROVIDER_URL; returns a structured 'not configured' error otherwise. Prefer animated CSS/JS for purely decorative motion. Costs 3 credits per successful call. Counts against the per-task creative-pack budget.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description:
              "Project-relative output path ending in .mp4. Defaults under assets/ if no folder is given.",
          },
          prompt: { type: "string", description: "Detailed description of the video." },
          aspect_ratio: {
            type: "string",
            enum: ["16:9", "9:16"],
            description: "16:9 landscape (default) or 9:16 portrait.",
          },
          duration_seconds: {
            type: "integer",
            description: "Clip length in seconds (2-8, default 6).",
          },
        },
        required: ["path", "prompt"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "generate_audio",
      description:
        "Synthesize speech from short text (≤30s) via OpenAI TTS. Use for onboarding voiceover, notification chimes, accessibility audio cues. Writes an MP3 (default) into the project at the given path. Costs 2 credits per call. Total combined creative-pack budget is 5 calls per task.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Project-relative output path ending in .mp3, .wav, or .ogg.",
          },
          text: { type: "string", description: "Text to read aloud (≤2000 chars / ~30s)." },
          voice: {
            type: "string",
            description: "Voice id (default 'alloy'). Examples: alloy, nova, shimmer.",
          },
          format: {
            type: "string",
            enum: ["mp3", "wav", "opus"],
            description: "Output audio format; defaults to mp3.",
          },
        },
        required: ["path", "text"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "remove_image_background",
      description:
        "Remove the background of an existing image already in the project workspace. Input must be PNG, JPEG, or WebP. Output is a transparent PNG written to `out_path` (or overwrites `path` when `out_path` is omitted). Costs 1 credit per call. Counts against the per-task creative-pack budget.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Existing image path in the project workspace." },
          out_path: {
            type: "string",
            description: "Optional output path ending in .png; defaults to overwriting `path`.",
          },
        },
        required: ["path"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "analyze_image",
      description:
        "Run a vision pass on an image and return a structured layout brief (overall layout, components, copy, colours, typography, intended app type). Use when the user drops in a screenshot/mockup/Figma export and you need a concrete, text-form description to ground the build. Input is either a project-relative path (e.g. 'assets/mockup.png') OR a data: / https: image URL. Returns plain-text analysis (≤2400 chars). No credit cost.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description:
              "Project-relative image path (PNG/JPEG/WebP). Mutually exclusive with `url`.",
          },
          url: {
            type: "string",
            description:
              "Image URL — `data:` URI or https://. Used when the image is an uploaded attachment not yet in the project workspace.",
          },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "author_skill",
      description:
        "Draft a new reusable skill (SKILL.md instruction set) when you discover a pattern that would help future builds. The draft is queued for admin review and is NOT immediately available to load. Use sparingly — only for genuinely reusable, non-trivial patterns (a new framework, a tricky integration). Body must include an '## Examples' section with real code.",
      parameters: {
        type: "object",
        properties: {
          slug: {
            type: "string",
            description:
              "URL-safe slug: lowercase letters/digits/dashes, e.g. 'tanstack-query'. Used as the folder name.",
          },
          name: {
            type: "string",
            description: "Human-friendly name shown in the index (defaults to slug).",
          },
          description: {
            type: "string",
            description: "One-line summary (≤240 chars) shown in the skill index.",
          },
          triggers: {
            type: "array",
            items: { type: "string" },
            description:
              "Keywords/phrases that should auto-suggest this skill when present in a user prompt.",
          },
          body: {
            type: "string",
            description:
              "Full SKILL.md body (markdown, no frontmatter — that's added automatically). MUST include an '## Examples' section.",
          },
          rationale: {
            type: "string",
            description:
              "Brief note to the reviewing admin explaining why this skill is worth adding.",
          },
        },
        required: ["slug", "description", "body"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "load_skill",
      description:
        "Load the full instructions for a named skill from the registry. Call this BEFORE generating code for a stack/feature listed in the 'Available skills' section. Returns the SKILL.md body. Loading the same skill twice in one run is free — it returns the cached content.",
      parameters: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "Skill name exactly as listed in the 'Available skills' section.",
          },
        },
        required: ["name"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "present_asset",
      description:
        "Mark an already-written project file as a downloadable asset for the user. Surfaces an inline asset card in the chat with a direct download link. Use for finished artifacts the user will want to grab (PDFs, ZIPs, generated images, exported data files, READMEs). The file must already exist in the workspace — call write_file first.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description:
              "Sandboxed project path to the asset (e.g. 'export/report.pdf', 'assets/poster.png').",
          },
          name: {
            type: "string",
            description:
              "Human-friendly title shown on the asset card. Falls back to the basename of `path` when omitted.",
          },
          description: {
            type: "string",
            description: "Optional one-line caption shown under the title.",
          },
        },
        required: ["path"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "user_query",
      description:
        "Pause the build and ask the user a single clarifying question with an interactive widget in chat. Returns { response, kind } once the user answers, or { canceled: true, reason: 'timeout'|'aborted' } after ~5 min / cancel. Use only when the answer cannot reasonably be inferred — payment provider choice, brand color preference, deploy region, etc. Do NOT use for questions you can answer yourself (lib choice, file naming).",
      parameters: {
        type: "object",
        properties: {
          question: { type: "string", description: "One short question, ≤ 500 chars." },
          kind: {
            type: "string",
            enum: ["choice", "boolean", "text"],
            description:
              "choice = chip buttons; boolean = confirm/cancel; text = free-form short answer.",
          },
          options: {
            type: "array",
            items: { type: "string" },
            description: "Required when kind=choice; 2-6 labels, ≤ 60 chars each.",
          },
          allow_multiple: {
            type: "boolean",
            description: "Only for kind=choice. Default false.",
          },
        },
        required: ["question", "kind"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "request_secret",
      description:
        "Pause the build and ask the user to provide a missing secret (API key, token). Renders an inline secret-entry form that writes to the project's encrypted secrets store via the existing AES-256-GCM path — the model NEVER sees the secret value. Returns { saved: true, name } once saved, or { canceled: true } after ~5 min / cancel. Use this instead of telling the user 'go to Tools & Files → Secrets'.",
      parameters: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "Env var name (UPPER_SNAKE_CASE), e.g. 'OPENAI_API_KEY'.",
          },
          category: {
            type: "string",
            enum: ["api_key", "oauth", "webhook", "database", "other"],
            description: "Defaults to 'api_key'.",
          },
          help_url: {
            type: "string",
            description: "Optional link explaining where the user can obtain this secret.",
          },
          reason: {
            type: "string",
            description: "Short one-line justification shown to the user.",
          },
        },
        required: ["name"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "install_package",
      description:
        "Install a single dependency by runtime — a structured, typed wrapper around pkg_install. runtime=node routes to npm; runtime=python routes to pip. Use this for the common case; pkg_install remains available if you need a specific manager (pnpm/yarn) or want to install dev deps under those managers.",
      parameters: {
        type: "object",
        properties: {
          runtime: { type: "string", enum: ["node", "python"] },
          name: { type: "string", description: "Package name." },
          version: {
            type: "string",
            description:
              "Optional version spec. node: semver range ('^3.22.0' / 'latest'). python: PEP 440 ('2.5.0' / '>=1.0,<2').",
          },
          dev: {
            type: "boolean",
            description: "Mark as devDependency (node/npm only — ignored for python).",
          },
        },
        required: ["runtime", "name"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "install_blueprint",
      description:
        "Task #542 — install a first-party integration blueprint (auth, payments, db, storage, ai). Idempotent: re-running for an already-installed blueprint is a no-op unless overwrite=true. Writes scaffold files into project_files, queues required secrets via request_secret style prompts (the user fills them in), and records the install in project_blueprints. Use this instead of hand-writing OAuth/Stripe/Postgres boilerplate. Use list_blueprints first to discover available ids.",
      parameters: {
        type: "object",
        properties: {
          id: {
            type: "string",
            description:
              "Blueprint id, e.g. 'auth-clerk-managed', 'payments-stripe', 'db-postgres'.",
          },
          overwrite: {
            type: "boolean",
            description:
              "Overwrite existing project files that conflict with blueprint files. Default false (skip conflicts).",
          },
        },
        required: ["id"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_blueprints",
      description:
        "List all available integration blueprints (id, name, category, description, required secrets). Use before install_blueprint to discover what's available.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "suggest_deploy",
      description:
        "After a successful build, present the user with a one-click 'Publish now' chip in chat. Does NOT pause the build — fire-and-forget. Use only when checks have passed and the preview is verified. The card triggers the existing publish flow (snapshot → public URL).",
      parameters: {
        type: "object",
        properties: {
          environment: {
            type: "string",
            enum: ["testing", "production"],
            description: "Defaults to 'testing'.",
          },
          note: {
            type: "string",
            description: "Short caption shown on the suggestion card (≤ 200 chars).",
          },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "dispatch_subagent",
      description:
        "Spawn a specialist subagent with a focused brief and a role-tuned tool catalog. Roles:\n• designer — generate/edit media (images, audio, background removal) and place them in the workspace.\n• explorer — read-only investigation (list_files, read_file, search, semantic_search, find_files, fetch_prod_logs) — never writes.\n• tester — run Playwright E2E (smoke or supplied scenarios) against the live preview.\n• reviewer — architect code review of the current diff (verdict + findings + suggested fixes).\nCosts per dispatch: designer 3, explorer 1, tester 2, reviewer 2. Each subagent runs in its own scoped agent-loop with a tighter step cap; control returns here with a structured summary you can act on.",
      parameters: {
        type: "object",
        properties: {
          role: {
            type: "string",
            enum: ["designer", "explorer", "tester", "reviewer"],
          },
          brief: {
            type: "string",
            description:
              "One-paragraph instruction for the subagent. Include the concrete deliverable (e.g. 'design a hero illustration at assets/hero.png matching the brand', 'find every file that references the legacy /v1 endpoint', 'run E2E covering signup → checkout', 'review the diff for security regressions').",
          },
          scenarios: {
            type: "array",
            description: "Optional E2E scenarios (tester role only). Same shape as run_e2e.",
            items: { type: "object" },
          },
        },
        required: ["role", "brief"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "plan_subtasks",
      description:
        "Decompose a goal into an ordered DAG of subtasks and execute each in an ISOLATED workspace clone, then 3-way merge the results back. Use for changes that touch several independent areas (e.g. 'add auth + analytics + dark mode'). Each subtask runs as its own agent-loop with a tighter step cap. Conflicts (same path edited by two subtasks divergently from the base) keep the parent's live version and are reported back so you can reconcile. Costs 1 credit per planned subtask (rounded up to the explorer rate). Use sparingly — for a single coherent change, just edit directly.",
      parameters: {
        type: "object",
        properties: {
          goal: {
            type: "string",
            description: "The overall outcome you want once all subtasks merge.",
          },
          max_subtasks: {
            type: "integer",
            description: "Hard cap on subtasks (1-6). Default 4.",
          },
        },
        required: ["goal"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "threat_model",
      description:
        "Run a structured STRIDE threat-modelling pass over the current project (or a focused scope). Calls gpt-5-mini with the project's file inventory + the supplied scope, returns a JSON report (assets, trust boundaries, threats classified by STRIDE category with likelihood + impact, mitigations), writes the rendered markdown to `threat_model.md` in the workspace, and stores a Knowledge Vault entry tagged `threat_model` so future builds can recall the mitigations. Use after auth/payment/data flows change, before publish, or whenever the user asks for a security review.",
      parameters: {
        type: "object",
        properties: {
          scope: {
            type: "string",
            description:
              "What to threat-model. Examples: 'entire app', 'login + session flow', 'Stripe checkout', 'user profile editing'. Keep ≤ 300 chars.",
          },
          assumptions: {
            type: "string",
            description:
              "Optional. Background the model should take as given (e.g. 'all traffic is HTTPS', 'single-tenant', 'no admin role yet').",
          },
        },
        required: ["scope"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "finalize",
      description:
        "Signal that the build is complete. Provide a 1-3 sentence summary for the user. Call this only after all required checks pass.",
      parameters: {
        type: "object",
        properties: {
          summary: { type: "string" },
          warnings: { type: "array", items: { type: "string" } },
        },
        required: ["summary"],
        additionalProperties: false,
      },
    },
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// System prompt
// ─────────────────────────────────────────────────────────────────────────────

function buildSystemPrompt(
  input: AgentLoopInput,
  stack: StackId,
  profile: { checks: CheckSpec[] },
  skillsIndex: string,
) {
  const checkList = profile.checks.map((c) => `  • ${c.id} (${c.label})`).join("\n");
  const isStatic = stack === "static-html";
  const isMobile = stack === "mobile-cross";
  const isDeveloperMode = input.projectMode === "developer";
  const strictness = input.policyStrictness ?? DEFAULT_POLICY_STRICTNESS;

  // In Developer Mode every project is a real server process inside a Linux
  // container — static-html is never a valid target.  If the stack still reads
  // "static-html" at this point (legacy row), treat it as node-api and warn the
  // agent explicitly.
  const effectivelyStatic = isStatic && !isDeveloperMode;

  const platformNote = effectivelyStatic
    ? "This is a STATIC web app (HTML/CSS/JS + Tailwind/lucide via CDN). No npm or build tools — `run_command` is restricted to in-process validators."
    : isMobile
      ? "This is a MOBILE cross-platform app (Expo SDK 52 / Expo Router v3 / NativeWind v4). Generate an Expo project AND an index.html web preview. `run_command` is restricted to in-process structural validators."
      : isDeveloperMode
        ? `This is a DEVELOPER MODE project running as a live server process inside a Linux container (stack: ${isStatic ? "node-api" : stack}).

## How the live preview works
write_file and apply_patch write directly to the container's filesystem — the same filesystem your dev server is watching. The full chain is automatic:

  1. You call write_file / apply_patch
  2. The dev server's filesystem watcher detects the change instantly
  3. The dev server pushes a hot-reload signal (HMR / WebSocket / SSE) to the preview iframe
  4. The preview refreshes — usually without a full page reload

The preview pane is an <iframe> connected to the dev server through the MustaFlow reverse proxy. The proxy is byte-transparent: it forwards HTTP requests, WebSocket upgrades, and SSE streams unchanged. Whatever the server returns is exactly what the iframe shows.

DO NOT manually restart the server after writing files. The filesystem watcher handles it. Restarting kills the HMR connection and causes a blank preview until the process comes back up.

## Critical: always bind to process.env.PORT
The container runtime injects PORT (default 3000). Your server MUST read it:
- Node.js/Express: const port = parseInt(process.env.PORT ?? "3000", 10); app.listen(port, ...)
- Python Flask:    port = int(os.environ.get("PORT", 3000)); app.run(host="0.0.0.0", port=port)
- Python FastAPI:  uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("PORT", 3000)))
- Go/Gin:          port := os.Getenv("PORT"); if port == "" { port = "3000" }; router.Run(":" + port)
Never hardcode a port other than as a fallback when PORT is unset.

The app must always be a real server that handles HTTP requests — never generate a static-HTML-only build. You may run any shell commands (npm/npx/tsc/python/go/etc.) via run_command. To add dependencies, use pkg_install.`
        : `This is a ${stack} project running inside a Linux container. You may run shell commands (npm/npx/tsc/python/etc.) via run_command. To add new dependencies, prefer pkg_install over raw \`npm install\`.`;
  return [
    isDeveloperMode
      ? `You are MustaFlow's Developer Mode AI. Your job is to ${input.mode === "build" ? "build" : "update"} a production-quality ${isStatic ? "Node.js/Express" : stack} server application that runs as a live process in a Linux container. The project is always containerized — never produce a raw static HTML bundle without a server.`
      : `You are MustaFlow's agentic app builder. Your job is to ${input.mode === "build" ? "create" : "refine"} a working ${stack} application that satisfies the user's request.`,
    "",
    platformNote,
    "",
    "## What you are",
    "You are a tool-using agent, not a chatbot. Every turn you either call a tool (taking a real action with real consequences) or finish the task. You do not produce text descriptions of code — you write the code.",
    "",
    "The loop you run:",
    "  1. Receive the request",
    "  2. Think — decide the single best next action",
    "  3. Call a tool (write_file writes a real file; run_command runs a real command; etc.)",
    "  4. Observe the result",
    "  5. Repeat until the task is complete, then call finalize",
    "",
    "This loop is what makes complex tasks possible. You plan, execute, observe, and adapt — turn by turn — rather than trying to do everything in one shot.",
    "",
    "## How you work",
    "- Ground yourself in the actual file state before editing — always read the file first. Your context may be stale; the filesystem is always current.",
    "- Use tools iteratively. Each turn, decide the next best action.",
    "- Search before you guess — use list_files or search to find the right file rather than assuming paths.",
    "- Before creating something new — a component, route, table, or service — search the project first to confirm it does not already exist. Duplicate entities cause cascading conflicts that are expensive to untangle.",
    "- Make small, focused changes. Prefer apply_patch for surgical edits, write_file for new/rewritten files.",
    "- After meaningful edits, run the checks for this stack to verify your work. Fix failures, then re-run.",
    "- Call `finalize` only after all required checks pass. Provide a short, accurate summary.",
    "",
    "## Failure modes to avoid",
    "- **Stale context propagation**: if you misread a file or assume a path without verifying, every subsequent decision builds on that wrong assumption. Re-read files after complex multi-step changes to confirm the result matches expectations.",
    "- **Silent command failures**: always inspect the stdout, stderr, and exit code of every run_command call. A non-zero exit or an error message in stderr means the command failed — do not proceed as if it succeeded. Fix the failure before continuing.",
    "- **Context window creep**: each tool result added to context costs tokens. For long-running tasks, prefer targeted reads (specific line ranges, search results) over full-file reads to keep context usage bounded. Stop and finalize as soon as the task is complete — do not keep looping unnecessarily.",
    "- **Credential exposure**: never log, print, or write environment variable values into files or comments. Reference secrets only by name (e.g. `process.env.STRIPE_SECRET_KEY`). The actual values are injected at runtime by the server — the agent never sees them and must never attempt to surface or echo them.",
    "",
    "## Required checks for this stack",
    checkList,
    "",
    "## Safety limits (will be enforced)",
    `- Maximum ${STEP_CAP} tool-calling steps.`,
    `- Maximum ${Math.round(WALL_CLOCK_MS / 60000)} minutes wall-clock.`,
    `- After ${REPEATED_ERROR_CAP} consecutive failures of the same operation, the loop aborts.`,
    `- Policy strictness for this project: ${strictness}.`,
    "- `run_command` deny-list blocks destructive ops, raw network sockets (curl/wget/nc/ssh), `| sh` pipelines, and inline code-eval flags.",
    "- `pkg_install` is the only sanctioned way to add dependencies (manager + package + optional version).",
    "- All file paths are sandboxed to the project root — no `..`, no absolute paths.",
    "",
    "## Output discipline",
    "- Never describe code in chat — write it with write_file / apply_patch.",
    "- `report_progress` is for ONE short sentence between major steps, not for explanations.",
    "- Avoid emojis in generated files and narration — use lucide icons in HTML output instead.",
    "",
    "## Diagnosing a broken published app",
    "- If the user's request mentions that the published/deployed app is broken, failing, throwing errors, or behaving unexpectedly in production — your FIRST action MUST be `fetch_prod_logs` to inspect grouped browser errors, recent requests, and the latest health-check before reading or editing files. Use the failure signatures it returns to target your fix.",
    "- After fixing, re-run the per-stack checks and finalize as usual. If `fetch_prod_logs` shows zero errors and the user still reports breakage, fall back to normal investigation.",
    skillsIndex ? `\n${skillsIndex}` : "",
    input.knowledgeContext ? `\n## Lessons from prior builds\n${input.knowledgeContext}` : "",
    input.planContext
      ? `\n## Plan to execute\n${JSON.stringify(input.planContext).slice(0, 2400)}`
      : "",
  ]
    .filter(Boolean)
    .join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// In-memory file workspace
// ─────────────────────────────────────────────────────────────────────────────

export class FileWorkspace {
  private files = new Map<string, BuilderFile>();
  private readonly initialPaths: Set<string>;
  /**
   * Monotonic last-modified timestamps per path. Initial-load files share the
   * workspace's construction time; every subsequent `write` bumps the entry's
   * mtime. Used by `find_files` to sort glob results most-recent-first
   * (matches Replit Agent's `find_files` contract).
   */
  private mtimes = new Map<string, number>();

  constructor(initial: BuilderFile[]) {
    const t0 = Date.now();
    for (const f of initial) {
      this.files.set(f.path, { ...f });
      this.mtimes.set(f.path, t0);
    }
    this.initialPaths = new Set(initial.map((f) => f.path));
  }

  list(): string[] {
    return Array.from(this.files.keys()).sort();
  }

  /** Paths with their last-modified timestamp (ms since epoch). */
  listWithMtimes(): Array<{ path: string; mtime: number }> {
    return Array.from(this.files.keys()).map((p) => ({
      path: p,
      mtime: this.mtimes.get(p) ?? 0,
    }));
  }

  read(path: string): BuilderFile | undefined {
    return this.files.get(path);
  }

  write(path: string, content: string, mimeType?: string): BuilderFile {
    const mt = mimeType ?? guessMime(path);
    const file: BuilderFile = { path, content, mimeType: mt };
    this.files.set(path, file);
    this.mtimes.set(path, Date.now());
    return file;
  }

  delete(path: string): boolean {
    this.mtimes.delete(path);
    return this.files.delete(path);
  }

  all(): BuilderFile[] {
    return Array.from(this.files.values());
  }

  diff(): { changed: BuilderFile[]; removed: string[]; unchanged: string[] } {
    const current = new Set(this.files.keys());
    const removed = Array.from(this.initialPaths).filter((p) => !current.has(p));
    const changed: BuilderFile[] = [];
    const unchanged: string[] = [];
    for (const f of this.files.values()) {
      const initial = this.initialContent(f.path);
      if (initial === undefined || initial !== f.content) changed.push(f);
      else unchanged.push(f.path);
    }
    return { changed, removed, unchanged };
  }

  private initialContentCache = new Map<string, string>();
  private initialContent(path: string): string | undefined {
    if (!this.initialPaths.has(path)) return undefined;
    return this.initialContentCache.get(path);
  }

  primeInitial(files: BuilderFile[]): void {
    for (const f of files) this.initialContentCache.set(f.path, f.content);
  }

  /**
   * Snapshot of current files. Used by subagent isolation (Task #535) to
   * capture the base before a sub-task runs in a cloned workspace.
   */
  snapshot(): BuilderFile[] {
    return Array.from(this.files.values()).map((f) => ({ ...f }));
  }

  /**
   * Create an isolated copy of this workspace. Sub-tasks (Task #535) mutate
   * the clone freely; the parent workspace stays untouched until the
   * three-way merge step. The clone's `initialPaths` mirrors the parent's
   * current state so its own `diff()` reports edits made *inside* the clone.
   */
  clone(): FileWorkspace {
    const copy = new FileWorkspace(this.snapshot());
    copy.primeInitial(this.snapshot());
    return copy;
  }

  search(query: string): string[] {
    const q = query.toLowerCase();
    const hits: string[] = [];
    for (const f of this.files.values()) {
      const lines = f.content.split("\n");
      for (let i = 0; i < lines.length && hits.length < 50; i++) {
        if (lines[i]!.toLowerCase().includes(q)) {
          hits.push(`${f.path}:${i + 1}: ${lines[i]!.slice(0, 200)}`);
        }
      }
      if (hits.length >= 50) break;
    }
    return hits;
  }
}

/**
 * Fire-and-forget embedding invalidation. Marks the stored project_embeddings
 * row for `path` stale so the next `semantic_search` re-embeds it. Safe to call
 * from hot paths — swallows errors (logged) so a transient DB issue never
 * breaks file writes.
 */
function invalidateEmbeddingSafe(projectId: number, path: string): Promise<void> {
  return import("./project-search")
    .then((m) => m.invalidateFileEmbedding(projectId, path))
    .catch((err) => {
      logger.warn({ err, projectId, path }, "embedding invalidation failed (non-fatal)");
    });
}

function guessMime(path: string): string {
  const p = path.toLowerCase();
  if (p.endsWith(".html")) return "text/html";
  if (p.endsWith(".css")) return "text/css";
  if (p.endsWith(".js") || p.endsWith(".mjs") || p.endsWith(".cjs"))
    return "application/javascript";
  if (p.endsWith(".ts") || p.endsWith(".tsx")) return "application/typescript";
  if (p.endsWith(".json")) return "application/json";
  if (p.endsWith(".md")) return "text/markdown";
  if (p.endsWith(".py")) return "text/x-python";
  if (p.endsWith(".svg")) return "image/svg+xml";
  return "text/plain";
}

// ─────────────────────────────────────────────────────────────────────────────
// Loop runner
// ─────────────────────────────────────────────────────────────────────────────

export async function runAgentLoop(input: AgentLoopInput): Promise<AgentLoopResult> {
  const stack = resolveStackId(input.projectKind, input.projectFormat, input.stack);
  const profile = CHECK_PROFILES[stack];
  const workspace = new FileWorkspace(input.existingFiles);
  workspace.primeInitial(input.existingFiles);

  const toolCalls: ToolCallRecord[] = [];
  const commandsRun: CommandRecord[] = [];
  const checkResults: CheckResultRecord[] = [];
  const e2eResults: E2eRunSummary[] = [];
  // Task-level screenshot budget (5MB) shared across smoke, run_e2e tool, and re-run.
  const screenshotBudget = { remaining: 5 * 1024 * 1024 };
  // Task #529: combined budget for web_fetch + web_search + extract_branding.
  // 20 calls / task — keeps cost predictable and bounds total egress.
  const fetchBudget = { remaining: 20 };
  const senseCounts = { screenshot: 0, webFetch: 0, webSearch: 0, branding: 0, diagnostics: 0 };
  // Task #530: per-task creative-pack budget (5 calls total across all 4 tools).
  const creativeBudget = { remaining: 5 };
  const creativeCounts = { image: 0, video: 0, audio: 0, bgRemoval: 0 };
  // Task #531: assets the agent has surfaced via present_asset. Threaded through
  // ToolCtx so the present_asset executeTool case can append to it.
  const presentedAssets: Array<{
    path: string;
    name: string;
    sizeBytes: number;
    mimeType: string;
    description?: string;
  }> = [];
  let totalTokens = 0;

  const startedAt = Date.now();
  const wallClockMs =
    typeof input.wallClockMs === "number" && Number.isFinite(input.wallClockMs)
      ? Math.min(30 * 60_000, Math.max(60_000, Math.floor(input.wallClockMs)))
      : WALL_CLOCK_MS;
  let lastError = "";
  let consecutiveErrors = 0;
  let terminationReason: AgentLoopReport["terminationReason"] = "model-stopped";
  let finalSummary = "";
  let finalWarnings: string[] = [];
  let finalized = false;
  // Count of file-mutation tool calls (write_file / apply_patch / delete_file)
  // across all turns. Used to enforce the refine-mode "must edit something" gate.
  let totalMutations = 0;
  // Separate counter for "finalize blocked because 0 mutations" events.
  // These are NOT real errors — the gate is working as intended — so they must
  // NOT increment consecutiveErrors (which would trip REPEATED_ERROR_CAP in 3 turns).
  let blockedFinalizeCount = 0;
  // Per-task skill registry: load index for the system prompt, then cache
  // already-loaded skills in this Map so a repeated load_skill is a free
  // cache hit (no double-count, no second LLM trip into the body).
  const enabledSkills = await listEnabledSkills();
  const skillsIndex = formatSkillIndex(enabledSkills, input.userPrompt);
  const loadedSkills = new Map<string, SkillManifest>();

  const messages: ChatCompletionMessageParam[] = [
    { role: "system", content: buildSystemPrompt(input, stack, profile, skillsIndex) },
  ];

  // Seed context: current file manifest + unread feedback items (Task #546).
  // Per requirement: surface unread inbox contents at build start so the model
  // sees them in initial context, and deterministically mark them read once the
  // first assistant turn lands (handled below right after the first model call).
  const seedManifest = workspace.list();
  let unreadInboxItems: {
    id: number;
    category: string;
    severity: string;
    description: string;
    screenshotUrl: string | null;
  }[] = [];
  try {
    const { db: _db, agentInboxTable } = await import("@workspace/db");
    const { and, eq, desc } = await import("drizzle-orm");
    const rows = await _db
      .select({
        id: agentInboxTable.id,
        category: agentInboxTable.category,
        severity: agentInboxTable.severity,
        description: agentInboxTable.description,
        screenshotUrl: agentInboxTable.screenshotUrl,
      })
      .from(agentInboxTable)
      .where(
        and(eq(agentInboxTable.projectId, input.projectId), eq(agentInboxTable.status, "unread")),
      )
      .orderBy(desc(agentInboxTable.createdAt))
      .limit(20);
    unreadInboxItems = rows;
  } catch {
    /* non-fatal — agent can still call read_inbox manually */
  }
  const inboxBlock =
    unreadInboxItems.length > 0
      ? `\n\n# Unread user feedback (${unreadInboxItems.length})\nAddress these before finalizing this build. Each item is already being marked as read; do not re-surface them in later builds.\n\n` +
        unreadInboxItems
          .map((it) => {
            const screenshot = it.screenshotUrl ? `\n  screenshot: ${it.screenshotUrl}` : "";
            const desc =
              it.description.length > 1200 ? it.description.slice(0, 1200) + "…" : it.description;
            return `#${it.id} [${it.severity}/${it.category}] — ${desc}${screenshot}`;
          })
          .join("\n\n")
      : "";
  const refineReminder =
    input.mode === "refine" && seedManifest.length > 0
      ? "\n\nIMPORTANT: This is a REFINE run. You MUST call write_file or apply_patch to edit at least one file before calling finalize. Do NOT call finalize immediately — read the relevant files first, then make the changes."
      : "";
  messages.push({
    role: "user",
    content:
      `User request:\n${input.userPrompt}\n\n` +
      `Current files in project (${seedManifest.length}):\n${
        seedManifest.length > 0 ? seedManifest.slice(0, 40).join("\n") : "(empty)"
      }` +
      inboxBlock +
      refineReminder +
      `\n\nConversation history follows.`,
  });
  // (Task #546) Surfaced unread items are marked read AFTER the first
  // assistant turn lands — see the `surfacedInboxIds` handling below the
  // first successful model response. If the first turn fails/aborts before
  // an assistant message is produced, items remain unread for the next build.
  const surfacedInboxIds: number[] = unreadInboxItems.map((it) => it.id);
  let inboxMarkedRead = false;
  for (const turn of (input.conversationHistory ?? []).slice(-6)) {
    messages.push({ role: turn.role, content: turn.content });
  }
  // Anthropic rejects conversations that end with an assistant turn ("assistant
  // prefill" is not supported). When conversationHistory ends on an assistant
  // message, append a minimal user bridge so the first API call is valid for
  // all providers. OpenAI accepts this turn harmlessly.
  if (messages.length > 0 && messages[messages.length - 1].role === "assistant") {
    messages.push({
      role: "user",
      content: "(Previous assistant response noted — proceed with the current request above.)",
    });
  }

  const model = MODEL_FOR_MODE[input.agentMode] ?? "gpt-5-mini";
  const containerState = { id: input.containerId ?? null, installed: false };

  // Task #542: discover MCP server tools at loop start so the model can call
  // them as `mcp__<server>__<tool>` alongside built-ins. Best-effort — if
  // discovery fails or no servers are registered, the loop runs with just
  // built-in tools. Capped at 30 tools total to keep token usage bounded.
  let mcpToolsCatalog: import("./mcp").McpTool[] = [];
  let toolsForLoop: ChatCompletionTool[] = TOOLS;
  try {
    const { discoverMcpTools } = await import("./mcp");
    mcpToolsCatalog = (await discoverMcpTools()).slice(0, 30);
    if (mcpToolsCatalog.length > 0) {
      toolsForLoop = [
        ...TOOLS,
        ...mcpToolsCatalog.map(
          (t): ChatCompletionTool => ({
            type: "function",
            function: {
              name: t.agentName,
              description: `[MCP:${t.serverName}] ${t.description}`.slice(0, 1000),
              parameters: (t.inputSchema ?? {
                type: "object",
                properties: {},
              }) as Record<string, unknown>,
            },
          }),
        ),
      ];
    }
  } catch (err) {
    logger.warn({ err }, "agent-loop: MCP tool discovery failed");
  }
  // Task #533: when a take_screenshot tool call returns an image, the next
  // LLM turn switches to the provider's VISION_MODEL so the screenshot is
  // actually inspected by a vision-capable model.
  let visionTurnsRemaining = 0;
  let step = 0;

  for (step = 1; step <= STEP_CAP; step++) {
    if (input.signal.aborted) {
      terminationReason = "aborted";
      break;
    }
    if (Date.now() - startedAt > wallClockMs) {
      terminationReason = "wall-clock";
      break;
    }
    if (consecutiveErrors >= REPEATED_ERROR_CAP) {
      terminationReason = "repeated-error";
      break;
    }
    // Total tool-call cap (not just LLM turns). STEP_CAP is the budget for the
    // entire run measured in tool calls so a single turn that emits many calls
    // cannot exceed the safety budget.
    if (toolCalls.length >= STEP_CAP) {
      terminationReason = "step-cap";
      break;
    }

    // Emit a live progress event so the frontend can show a step counter and
    // wall-clock progress bar without polling. Include the last executed tool
    // name so the UI can show context about what just happened.
    await safeEvent(
      input.onEvent,
      "loop:step",
      JSON.stringify({
        stepIndex: toolCalls.length + 1,
        stepCap: STEP_CAP,
        wallClockElapsedMs: Date.now() - startedAt,
        wallClockBudgetMs: wallClockMs,
        toolName: toolCalls[toolCalls.length - 1]?.tool ?? null,
      }),
    );

    // Inject any mid-run steering hint the user submitted via POST /steer.
    // Consumed once (deleted after this read) so it only applies to this turn.
    if (input.taskId) {
      const { consumeSteeringHint } = await import("./steering-hints");
      const hint = await consumeSteeringHint(input.taskId);
      if (hint) {
        messages.push({
          role: "system",
          content: `[User steering hint — apply immediately]: ${hint}`,
        });
        await safeEvent(
          input.onEvent,
          "narration",
          `Applying your update: "${hint.slice(0, 120)}"`,
        );
      }
    }

    let response;
    try {
      const { createChatCompletion, resolveStageProvider, VISION_MODEL } =
        await import("./ai-providers");
      // Pass agent-mode OpenAI default (`model`) as openaiOverride so an
      // `AI_PROVIDER_BUILD=openai:<model>` env wins for the loop's main LLM
      // call, but unset env keeps the historical agent-mode default.
      const { provider, model: routedModel } = resolveStageProvider(
        input.mode === "refine" ? "refine" : "build",
        input.agentMode,
        model,
      );
      // Vision-override: if a screenshot was just pushed, this turn must use a
      // vision-capable model regardless of stage routing (Task #533).
      const useVision = visionTurnsRemaining > 0;
      if (useVision) visionTurnsRemaining -= 1;
      const effectiveModel = useVision ? VISION_MODEL[provider] : routedModel;
      response = await createChatCompletion({
        provider,
        model: effectiveModel,
        messages,
        tools: toolsForLoop,
        tool_choice: "required",
        signal: input.signal,
      });
    } catch (err) {
      if (input.signal.aborted) {
        terminationReason = "aborted";
        break;
      }
      // Circuit breaker open — AI provider is temporarily degraded.
      // Don't count against consecutiveErrors (it would silently exhaust
      // REPEATED_ERROR_CAP). Instead break immediately with a clear message.
      if (err instanceof Error && err.constructor.name === "CircuitOpenError") {
        logger.warn({ err, step }, "agent-loop: circuit breaker open — aborting loop");
        terminationReason = "repeated-error";
        finalSummary = "The AI service is temporarily unavailable. Please try again in 30 seconds.";
        break;
      }
      logger.warn({ err, step }, "agent-loop: model call failed");
      lastError = String((err as Error).message ?? err);
      consecutiveErrors++;
      continue;
    }

    totalTokens += response.usage?.total_tokens ?? 0;
    const choice = response.choices[0];
    if (!choice) {
      terminationReason = "model-stopped";
      break;
    }
    const msg = choice.message;
    const toolReqs: ChatCompletionMessageToolCall[] = msg.tool_calls ?? [];

    messages.push({
      role: "assistant",
      content: msg.content ?? "",
      tool_calls: toolReqs.length > 0 ? toolReqs : undefined,
    });

    // Task #733: when the model emits free-form prose alongside tool_calls
    // (i.e. a brief plan / "I'll first read X, then patch Y" thought), surface
    // it as a `thinking` event so the chat bubble can show 1-3 lines of
    // muted reasoning between tool steps. Pure-text turns are handled by the
    // existing model-stopped branch below and don't need a thinking event.
    if (toolReqs.length > 0 && msg.content) {
      await emitThinkingEvent(input.onEvent, String(msg.content));
    }

    // Task #546: mark surfaced unread inbox items as read exactly once, after
    // the first assistant turn produces output. Skipping the DB write before
    // this point ensures unread feedback survives an aborted first turn.
    if (!inboxMarkedRead && surfacedInboxIds.length > 0) {
      inboxMarkedRead = true;
      try {
        const { db: _db, agentInboxTable } = await import("@workspace/db");
        const { inArray } = await import("drizzle-orm");
        await _db
          .update(agentInboxTable)
          .set({ status: "read", readAt: new Date() })
          .where(inArray(agentInboxTable.id, surfacedInboxIds));
      } catch (err) {
        logger.warn(
          { err, projectId: input.projectId, count: surfacedInboxIds.length },
          "agent-loop: failed to mark surfaced inbox items as read (non-fatal)",
        );
      }
    }

    if (toolReqs.length === 0) {
      // tool_choice is "required" so this should never happen, but guard anyway.
      if (msg.content && msg.content.length > 0) {
        finalSummary = msg.content.slice(0, 600);
      }
      terminationReason = "model-stopped";
      break;
    }

    let stepFinalized = false;
    let mutatedThisTurn = false;

    // Task #531: tools that mutate container/workspace state, run shell
    // commands, hit credit-metered async budgets, or must terminate the loop
    // run SERIALLY. Pure reads (read_file/list_files/search), narration
    // (report_progress), asset surfacing (present_asset), network senses
    // (web_fetch/web_search/take_screenshot/extract_branding) and skill
    // loading are safe to parallelize.
    //
    // File mutation tools stay serial because each one performs an async
    // container sync (writeFileToContainer / rm via exec). Two parallel writes
    // to the same path would race on container disk even though the in-memory
    // workspace is deterministic — leading to a stale subsequent check run.
    // Creative tools (generate_image/video/audio/remove_image_background)
    // stay serial because their budget reservation is checked-then-decremented
    // across an await, which is not atomic under Promise.all.
    const SERIAL_TOOLS = new Set([
      "run_command",
      "run_workflow",
      "pkg_install",
      "read_diagnostics",
      "fetch_prod_logs",
      "run_e2e",
      "finalize",
      "write_file",
      "apply_patch",
      "delete_file",
      "generate_image",
      "generate_video",
      "generate_audio",
      "remove_image_background",
      // Task #532: human-in-the-loop tools pause the loop awaiting user input.
      // Must be serial so a single LLM turn can't fan out multiple modal
      // prompts simultaneously. install_package is serial because it shells
      // into the container like pkg_install.
      "user_query",
      "request_secret",
      "install_package",
      // Task #542: writes project_files + queues secret prompts, must be serial.
      "install_blueprint",
    ]);

    // Parse a tool call's arguments once.
    const parseArgs = (call: ChatCompletionMessageToolCall): Record<string, unknown> => {
      if (call.type !== "function") return {};
      try {
        return call.function.arguments ? JSON.parse(call.function.arguments) : {};
      } catch {
        return {};
      }
    };

    // Process a single tool result against the shared turn state. Returns
    // true if the loop should terminate (step-cap, finalize success). The
    // outer caller still handles finalize-specific block detection.
    const handleToolResult = async (
      call: ChatCompletionMessageToolCall,
      parsed: Record<string, unknown>,
      result: {
        ok: boolean;
        observation: string | unknown;
        noTruncate?: boolean;
        imageBase64?: string;
        imageMimeType?: string;
      },
      durationMs: number,
    ): Promise<{ terminate: boolean; observation: string }> => {
      const callName = call.type === "function" ? call.function.name : "";
      const TRUNCATE_CAP = result.noTruncate ? 7_000_000 : MAX_OBSERVATION_CHARS;
      const observation =
        typeof result.observation === "string"
          ? result.observation.slice(0, TRUNCATE_CAP)
          : JSON.stringify(result.observation).slice(0, TRUNCATE_CAP);

      const redactedArgsForEvent = redactArgs(parsed);
      toolCalls.push({
        step,
        tool: callName,
        args: redactedArgsForEvent,
        ok: result.ok,
        durationMs,
        preview: observation.slice(0, 400),
      });

      // Task #743: stream a structured `tool_call` event so the chat UI can
      // render each invocation as a collapsible step with args + truncated
      // output. Skip for tools that already have richer dedicated events
      // (file_diff, command_output, creative previews) to avoid double-render.
      if (shouldEmitToolCallEvent(callName)) {
        try {
          const payload = JSON.stringify(
            buildToolCallEventPayload(
              callName,
              redactedArgsForEvent,
              result.ok,
              durationMs,
              observation,
            ),
          );
          await safeEvent(input.onEvent, "tool_call", payload);
        } catch {
          // event emission must never break the loop
        }
      }

      if (result.ok) {
        consecutiveErrors = 0;
      } else {
        if (lastError === observation) consecutiveErrors++;
        else consecutiveErrors = 1;
        lastError = observation;
      }

      if (callName === "report_progress") {
        await safeEvent(input.onEvent, "narration", String(parsed.message ?? "").slice(0, 220));
      } else if (
        callName === "write_file" ||
        callName === "apply_patch" ||
        callName === "delete_file"
      ) {
        mutatedThisTurn = true;
        totalMutations++;
        await safeEvent(
          input.onEvent,
          "generating_code",
          `${callName.replace("_", " ")} → ${String(parsed.path ?? "")}`.slice(0, 220),
        );
      } else if (callName === "run_command") {
        await safeEvent(
          input.onEvent,
          "narration",
          `Running: ${(parsed.argv as string[] | undefined)?.slice(-1)[0] ?? "command"}`.slice(
            0,
            220,
          ),
        );
      }

      messages.push({ role: "tool", tool_call_id: call.id, content: observation });

      // Vision wiring (Task #533): when a tool returns an image, attach it as
      // an image_url block on a follow-up user message and request a vision
      // turn next. The adapters in ai-providers translate image_url blocks
      // into Anthropic image blocks / Gemini inlineData parts.
      if (result.imageBase64 && result.imageMimeType) {
        const dataUri = `data:${result.imageMimeType};base64,${result.imageBase64}`;
        messages.push({
          role: "user",
          content: [
            {
              type: "text",
              text: `Screenshot captured by ${callName}. Inspect the image above to inform your next step.`,
            },
            { type: "image_url", image_url: { url: dataUri } },
          ],
        });
        visionTurnsRemaining = 1;
      }

      if (toolCalls.length >= STEP_CAP && callName !== "finalize") {
        terminationReason = "step-cap";
        return { terminate: true, observation };
      }
      return { terminate: false, observation };
    };

    // Greedy batching: consecutive parallel-safe calls run via Promise.all.
    // Order is preserved when pushing tool-result messages so OpenAI's
    // tool_call_id pairing stays predictable across the conversation log.
    let callIdx = 0;
    while (callIdx < toolReqs.length) {
      if (input.signal.aborted) {
        terminationReason = "aborted";
        stepFinalized = true;
        break;
      }

      // Collect a batch of consecutive parallel-safe calls (function-type only).
      const batch: Array<Extract<ChatCompletionMessageToolCall, { type: "function" }>> = [];
      while (callIdx < toolReqs.length) {
        const c = toolReqs[callIdx]!;
        if (c.type !== "function") {
          callIdx++;
          continue;
        }
        if (SERIAL_TOOLS.has(c.function.name)) break;
        batch.push(c);
        callIdx++;
      }

      // Pre-execution STEP_CAP clamp: never start more parallel calls than the
      // remaining tool-call budget allows. Without this, a single LLM response
      // emitting many parallel-safe calls could fire billable/network side
      // effects past STEP_CAP before the mid-loop guard in handleToolResult
      // observed the breach.
      if (batch.length > 0) {
        const remainingBudget = Math.max(0, STEP_CAP - toolCalls.length);
        if (remainingBudget === 0) {
          terminationReason = "step-cap";
          stepFinalized = true;
          break;
        }
        if (batch.length > remainingBudget) {
          batch.length = remainingBudget;
        }
        const parsedBatch = batch.map((c) => parseArgs(c));
        const tBatchStart = Date.now();
        const settled = await Promise.all(
          batch.map((c, idx) =>
            executeTool({
              name: c.function.name,
              args: parsedBatch[idx]!,
              workspace,
              stack,
              profile,
              input,
              commandsRun,
              step,
              containerState,
              loadedSkills,
              e2eResults,
              screenshotBudget,
              fetchBudget,
              senseCounts,
              creativeBudget,
              creativeCounts,
              presentedAssets,
              loopStartedAt: startedAt,
              loopWallClockMs: wallClockMs,
              mcpToolsCatalog,
            })
              .then((r) => ({
                ok: r.ok,
                observation: r.observation,
                noTruncate: r.noTruncate,
                imageBase64: r.imageBase64,
                imageMimeType: r.imageMimeType,
              }))
              .catch((err) => ({
                ok: false as const,
                observation: `ERROR: ${String((err as Error).message ?? err)}`,
                noTruncate: false,
              })),
          ),
        );
        const batchDuration = Date.now() - tBatchStart;
        // Use the wall-clock duration of the whole batch as the per-call
        // durationMs (parallel calls share the same window) — keeps the
        // run report's per-call timing honest.
        for (let k = 0; k < batch.length; k++) {
          const res = await handleToolResult(
            batch[k]!,
            parsedBatch[k]!,
            settled[k]!,
            batchDuration,
          );
          if (res.terminate) {
            stepFinalized = true;
            break;
          }
        }
        if (stepFinalized) break;
        continue;
      }

      // Serial call (run_command / finalize / pkg_install / etc.)
      const call = toolReqs[callIdx++]!;
      if (call.type !== "function") continue;
      const name = call.function.name;
      const parsed = parseArgs(call);
      const tStart = Date.now();
      const result = await executeTool({
        name,
        args: parsed,
        workspace,
        stack,
        profile,
        input,
        commandsRun,
        step,
        containerState,
        loadedSkills,
        e2eResults,
        screenshotBudget,
        fetchBudget,
        senseCounts,
        creativeBudget,
        creativeCounts,
        presentedAssets,
        loopStartedAt: startedAt,
        loopWallClockMs: wallClockMs,
        mcpToolsCatalog,
      });
      const durationMs = Date.now() - tStart;

      // Most tool observations are truncated to MAX_OBSERVATION_CHARS (8KB) so
      // a runaway stdout can't blow the context window. Tools that need to
      // return raw binary-ish payloads (e.g. take_screenshot's base64 PNG) set
      // `noTruncate` and we cap them at a much larger ceiling instead.
      const TRUNCATE_CAP = result.noTruncate ? 7_000_000 : MAX_OBSERVATION_CHARS;
      const observation =
        typeof result.observation === "string"
          ? result.observation.slice(0, TRUNCATE_CAP)
          : JSON.stringify(result.observation).slice(0, TRUNCATE_CAP);

      const redactedArgsForSerial = redactArgs(parsed);
      toolCalls.push({
        step,
        tool: name,
        args: redactedArgsForSerial,
        ok: result.ok,
        durationMs,
        preview: observation.slice(0, 400),
      });

      // Task #743: stream a structured `tool_call` event (serial path).
      if (shouldEmitToolCallEvent(name)) {
        try {
          const payload = JSON.stringify(
            buildToolCallEventPayload(
              name,
              redactedArgsForSerial,
              result.ok,
              durationMs,
              observation,
            ),
          );
          await safeEvent(input.onEvent, "tool_call", payload);
        } catch {
          // event emission must never break the loop
        }
      }

      if (result.ok) {
        consecutiveErrors = 0;
      } else {
        if (lastError === observation) consecutiveErrors++;
        else consecutiveErrors = 1;
        lastError = observation;
      }

      // Emit narration for high-signal tools
      if (name === "report_progress") {
        await safeEvent(input.onEvent, "narration", String(parsed.message ?? "").slice(0, 220));
      } else if (name === "write_file" || name === "apply_patch" || name === "delete_file") {
        mutatedThisTurn = true;
        totalMutations++;
        await safeEvent(
          input.onEvent,
          "generating_code",
          `${name.replace("_", " ")} → ${String(parsed.path ?? "")}`.slice(0, 220),
        );
      } else if (name === "run_command") {
        await safeEvent(
          input.onEvent,
          "narration",
          `Running: ${(parsed.argv as string[] | undefined)?.slice(-1)[0] ?? "command"}`.slice(
            0,
            220,
          ),
        );
      }

      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: observation,
      });

      // Vision wiring (Task #533, serial path): mirror handleToolResult above.
      if (result.imageBase64 && result.imageMimeType) {
        const dataUri = `data:${result.imageMimeType};base64,${result.imageBase64}`;
        messages.push({
          role: "user",
          content: [
            {
              type: "text",
              text: `Screenshot captured by ${name}. Inspect the image above to inform your next step.`,
            },
            { type: "image_url", image_url: { url: dataUri } },
          ],
        });
        visionTurnsRemaining = 1;
      }

      // Enforce tool-call cap mid-turn — stop immediately if we hit the budget
      // partway through a multi-tool-call response.
      if (toolCalls.length >= STEP_CAP && name !== "finalize") {
        terminationReason = "step-cap";
        stepFinalized = true; // borrow flag to break the outer for-loop too
        break;
      }

      if (name === "finalize") {
        // Hard gate for refine runs: the model must have written or patched at
        // least one file before finalizing. Prevents the "Refined 0 files"
        // failure mode where the model calls finalize immediately on a vague
        // prompt without doing any work.
        if (input.mode === "refine" && totalMutations === 0) {
          blockedFinalizeCount++;
          // Give up only after many blocked attempts — this is a model behaviour
          // issue, not a real execution error, so it must NOT touch consecutiveErrors.
          if (blockedFinalizeCount > 6) {
            terminationReason = "model-stopped";
            break;
          }
          // Reset consecutiveErrors so real errors are tracked independently.
          consecutiveErrors = 0;
          lastError = "";
          const noMutMsg =
            "BLOCKED: You have not written or modified any files yet. " +
            "You MUST call write_file or apply_patch to make at least one concrete change before calling finalize. " +
            "Read the existing files first if needed, then write or patch the file(s) that implement the user's request.";
          messages[messages.length - 1] = {
            role: "tool",
            tool_call_id: call.id,
            content: noMutMsg,
          };
          continue;
        }

        // Run checks now; only terminate if required checks pass.
        await safeEvent(input.onEvent, "narration", "Verifying checks before finalizing…");
        const verifyRun = await runCheckProfile(
          profile.checks,
          workspace,
          { ...input, containerId: containerState.id },
          containerState,
          profile.installCmd,
        );
        const verifyFailed = profile.checks.filter(
          (c) => c.required && !verifyRun.find((r) => r.id === c.id)?.passed,
        );
        if (verifyFailed.length === 0) {
          finalized = true;
          stepFinalized = true;
          finalSummary = String(parsed.summary ?? "").slice(0, 800);
          const w = parsed.warnings;
          if (Array.isArray(w)) finalWarnings = w.map((x) => String(x).slice(0, 200)).slice(0, 10);
          terminationReason = "finalized";
          // Overwrite the generic "finalized" observation in the last tool message
          messages[messages.length - 1] = {
            role: "tool",
            tool_call_id: call.id,
            content: "finalized — all required checks passed",
          };
          break;
        }
        // Required checks failed → feed back and continue looping
        const failMsg =
          `BLOCKED: cannot finalize — these required checks failed:\n` +
          verifyFailed
            .map((c) => {
              const r = verifyRun.find((x) => x.id === c.id);
              return `- ${c.id}: ${r?.message ?? "failed"}`;
            })
            .join("\n") +
          `\nFix the failures and call finalize again.`;
        messages[messages.length - 1] = {
          role: "tool",
          tool_call_id: call.id,
          content: failMsg.slice(0, MAX_OBSERVATION_CHARS),
        };
        // Treat as an error event so consecutiveErrors tracks repeated failure
        if (lastError === failMsg) consecutiveErrors++;
        else consecutiveErrors = 1;
        lastError = failMsg;
      }
    }

    if (stepFinalized) break;

    // Auto-verify after each turn that included a mutating tool call but did
    // not call finalize. Runs the per-stack check profile and injects the
    // outcome as a synthetic system message so the next turn can react.
    // Skipped on abort to keep cancel prompt.
    if (mutatedThisTurn && !finalized && !input.signal.aborted) {
      const turnChecks = await runCheckProfile(
        profile.checks,
        workspace,
        { ...input, containerId: containerState.id },
        containerState,
        profile.installCmd,
      );
      const turnFailed = profile.checks.filter(
        (c) => c.required && !turnChecks.find((r) => r.id === c.id)?.passed,
      );
      if (turnFailed.length > 0) {
        const summary =
          `[auto-check] required checks failing after your edits:\n` +
          turnFailed
            .map((c) => {
              const r = turnChecks.find((x) => x.id === c.id);
              return `- ${c.id}: ${(r?.message ?? "failed").slice(0, 200)}`;
            })
            .join("\n") +
          `\nFix and continue, then call finalize.`;
        messages.push({ role: "system", content: summary.slice(0, MAX_OBSERVATION_CHARS) });
      } else {
        messages.push({
          role: "system",
          content: "[auto-check] all required checks passing. You may call finalize.",
        });
      }
    }
  }

  // If the loop exited via the for-condition without break, it's a step-cap exhaustion.
  if (step > STEP_CAP && terminationReason === "model-stopped" && !finalized) {
    terminationReason = "step-cap";
  }

  // Emit a plain-language narration for hard termination reasons so the chat
  // bubble gives the user actionable context instead of just going silent.
  if (!input.signal.aborted) {
    const changedCount = workspace.diff().changed.length;
    if (terminationReason === "step-cap") {
      const fileNote =
        changedCount > 0
          ? ` — ${changedCount} file${changedCount !== 1 ? "s" : ""} were created or modified`
          : "";
      await safeEvent(
        input.onEvent,
        "narration",
        `Reached the step limit${fileNote}. You can continue with a follow-up prompt.`,
      );
    } else if (terminationReason === "wall-clock") {
      const fileNote =
        changedCount > 0
          ? ` after modifying ${changedCount} file${changedCount !== 1 ? "s" : ""}`
          : "";
      await safeEvent(
        input.onEvent,
        "narration",
        `Reached the time budget${fileNote}. You can continue with a follow-up prompt.`,
      );
    }
  }

  // ── Post-loop: run required checks (whether the model finalized or not) ──
  // Skip when aborted — cancel should not be blocked waiting on checks.
  if (input.signal.aborted) {
    terminationReason = "aborted";
    const diff = workspace.diff();
    const allFiles = workspace.all();
    return {
      files: allFiles,
      changedFiles: diff.changed,
      removedPaths: diff.removed,
      unchangedFiles: diff.unchanged,
      assistantSummary: finalSummary || "Aborted by user.",
      warnings: finalWarnings,
      checksFailed: true,
      loopReport: {
        stack,
        steps: Math.min(toolCalls.length, STEP_CAP),
        totalToolCalls: toolCalls.length,
        totalTokens,
        terminationReason,
        toolCalls,
        commandsRun,
        checkResults,
        skillsLoaded: Array.from(loadedSkills.keys()),
        e2eResults: e2eResults[e2eResults.length - 1] ?? null,
        senseCalls: { ...senseCounts },
        creativeCalls: { ...creativeCounts },
        assets: presentedAssets.slice(),
      },
    };
  }
  await safeEvent(input.onEvent, "narration", "Running checks…");
  const checkRun = await runCheckProfile(
    profile.checks,
    workspace,
    { ...input, containerId: containerState.id },
    containerState,
    profile.installCmd,
  );
  checkResults.push(...checkRun);
  const requiredFailed = profile.checks.some(
    (c) => c.required && !checkRun.find((r) => r.id === c.id)?.passed,
  );

  if (requiredFailed && !finalized) {
    terminationReason = "checks-failed";
  } else if (requiredFailed && terminationReason === "finalized") {
    terminationReason = "checks-failed";
  }

  if (!STEP_CAP_REACHED(toolCalls.length) && terminationReason === "model-stopped" && finalized) {
    // keep finalized
  }

  // ── Auto-smoke E2E after successful builds on web-runnable stacks ─────────
  // Only fires on initial builds (mode === "build"), when checks passed, e2e
  // is enabled for the project, and no run_e2e has happened yet. If failures
  // are detected, we grant one extra LLM turn for the model to fix and then
  // re-run smoke once.
  // All stacks that produce something a browser can load: static apps,
  // SPA dev servers, SSR frameworks, HTTP backends (when they serve a page),
  // and mobile-cross (its index.html web preview). Auto-smoke runs on every
  // successful build OR refine — per-project `e2eEnabled` is the master switch.
  const webRunnable: StackId[] = [
    "static-html",
    "react-vite",
    "nextjs",
    "node-api",
    "python-flask",
    "python-fastapi",
    "mobile-cross",
  ];
  const shouldAutoSmoke =
    input.e2eEnabled !== false &&
    !requiredFailed &&
    !input.signal.aborted &&
    webRunnable.includes(stack) &&
    e2eResults.length === 0 &&
    (input.previewUrl != null || stack === "static-html" || stack === "mobile-cross");

  if (shouldAutoSmoke) {
    const fallbackHtml =
      stack === "static-html" ? (workspace.read("index.html")?.content ?? null) : null;
    const previewUrl = input.previewUrl ?? null;
    if (previewUrl || fallbackHtml) {
      await safeEvent(input.onEvent, "narration", "Running smoke E2E…");
      const smokeStart = Date.now();
      const smokeRun = await runE2eScenarios({
        targetUrl: previewUrl,
        fallbackHtml,
        scenarios: defaultSmokeScenarios(),
        maxScreenshotBytes: screenshotBudget.remaining,
        signal: input.signal,
      });
      screenshotBudget.remaining = Math.max(
        screenshotBudget.remaining - estimateScreenshotBytes(smokeRun),
        0,
      );
      const smokeElapsed = Date.now() - smokeStart;
      if (previewUrl) {
        const userSpecs = discoverUserSpecs(workspace.all());
        if (userSpecs.length > 0) {
          const userResults = await runUserSpecs({
            specs: userSpecs,
            baseUrl: previewUrl,
            projectId: input.projectId,
            containerId: containerState.id,
            totalBudgetMs: Math.max(60_000 - smokeElapsed, 0),
            maxSpecs: Math.max(10 - smokeRun.scenarios.length, 0),
            signal: input.signal,
          });
          mergeUserResults(smokeRun, userResults);
        }
      }
      e2eResults.push(smokeRun);

      if (smokeRun.failed > 0 && !input.signal.aborted) {
        smokeRun.autoFixAttempted = true;
        await safeEvent(
          input.onEvent,
          "narration",
          `E2E found ${smokeRun.failed} failure(s) — attempting one fix turn…`,
        );
        messages.push({
          role: "system",
          content:
            `[e2e auto-fix] The smoke E2E pass found ${smokeRun.failed} failure(s). ` +
            `You have ONE turn to fix them and call finalize. Failures:\n` +
            renderE2eObservation(smokeRun).slice(0, MAX_OBSERVATION_CHARS),
        });
        try {
          const { createChatCompletion, resolveStageProvider } = await import("./ai-providers");
          const { provider: fixProv, model: fixModel } = resolveStageProvider(
            input.mode === "refine" ? "refine" : "build",
            input.agentMode,
            model,
          );
          const fixResp = await createChatCompletion({
            provider: fixProv,
            model: fixModel,
            messages,
            tools: toolsForLoop,
            tool_choice: "auto",
            signal: input.signal,
          });
          totalTokens += fixResp.usage?.total_tokens ?? 0;
          const fixChoice = fixResp.choices[0];
          const fixMsg = fixChoice?.message;
          const fixToolReqs: ChatCompletionMessageToolCall[] = fixMsg?.tool_calls ?? [];
          if (fixMsg) {
            messages.push({
              role: "assistant",
              content: fixMsg.content ?? "",
              tool_calls: fixToolReqs.length > 0 ? fixToolReqs : undefined,
            });
          }
          for (const call of fixToolReqs.slice(0, 8)) {
            if (call.type !== "function") continue;
            if (toolCalls.length >= STEP_CAP) break;
            let parsed: Record<string, unknown> = {};
            try {
              parsed = call.function.arguments ? JSON.parse(call.function.arguments) : {};
            } catch {
              parsed = {};
            }
            const tStart = Date.now();
            const r = await executeTool({
              name: call.function.name,
              args: parsed,
              workspace,
              stack,
              profile,
              input,
              commandsRun,
              step: step + 1,
              containerState,
              loadedSkills,
              e2eResults,
              screenshotBudget,
              fetchBudget,
              senseCounts,
              creativeBudget,
              creativeCounts,
              presentedAssets,
              loopStartedAt: startedAt,
              loopWallClockMs: wallClockMs,
              mcpToolsCatalog,
            });
            toolCalls.push({
              step: step + 1,
              tool: call.function.name,
              args: redactArgs(parsed),
              ok: r.ok,
              durationMs: Date.now() - tStart,
              preview: String(r.observation).slice(0, 400),
            });
            messages.push({
              role: "tool",
              tool_call_id: call.id,
              content: String(r.observation).slice(0, MAX_OBSERVATION_CHARS),
            });
          }
          // Re-run smoke once if the fix turn produced any mutation
          if (
            fixToolReqs.some(
              (c) =>
                c.type === "function" &&
                ["write_file", "apply_patch", "delete_file"].includes(c.function.name),
            )
          ) {
            const reRun = await runE2eScenarios({
              targetUrl: previewUrl,
              fallbackHtml:
                stack === "static-html" ? (workspace.read("index.html")?.content ?? null) : null,
              scenarios: defaultSmokeScenarios(),
              maxScreenshotBytes: screenshotBudget.remaining,
              signal: input.signal,
            });
            screenshotBudget.remaining = Math.max(
              screenshotBudget.remaining - estimateScreenshotBytes(reRun),
              0,
            );
            if (previewUrl) {
              const userSpecs = discoverUserSpecs(workspace.all());
              if (userSpecs.length > 0) {
                const userResults = await runUserSpecs({
                  specs: userSpecs,
                  baseUrl: previewUrl,
                  projectId: input.projectId,
                  containerId: containerState.id,
                  totalBudgetMs: Math.max(60_000 - reRun.totalDurationMs, 0),
                  maxSpecs: Math.max(10 - reRun.scenarios.length, 0),
                  signal: input.signal,
                });
                mergeUserResults(reRun, userResults);
              }
            }
            reRun.autoFixAttempted = true;
            e2eResults.push(reRun);
          }
        } catch (err) {
          logger.warn({ err }, "agent-loop: e2e auto-fix turn failed");
        }
      }
    }
  }

  const lastE2e = e2eResults[e2eResults.length - 1] ?? null;
  const diff = workspace.diff();
  const allFiles = workspace.all();

  return {
    files: allFiles,
    changedFiles: diff.changed,
    removedPaths: diff.removed,
    unchangedFiles: diff.unchanged,
    assistantSummary:
      finalSummary ||
      (input.mode === "build"
        ? `Built ${allFiles.length} file${allFiles.length === 1 ? "" : "s"} via agentic loop.`
        : `Refined ${diff.changed.length} file${diff.changed.length === 1 ? "" : "s"} via agentic loop.`),
    warnings: finalWarnings,
    checksFailed: requiredFailed,
    loopReport: {
      stack,
      steps: Math.min(toolCalls.length, STEP_CAP),
      totalToolCalls: toolCalls.length,
      totalTokens,
      terminationReason,
      toolCalls,
      commandsRun,
      checkResults,
      skillsLoaded: Array.from(loadedSkills.keys()),
      e2eResults: lastE2e,
      senseCalls: { ...senseCounts },
      creativeCalls: { ...creativeCounts },
      assets: presentedAssets.slice(),
    },
  };
}

function STEP_CAP_REACHED(n: number): boolean {
  return n >= STEP_CAP;
}

async function safeEvent(fn: AgentLoopEvent, type: string, msg: string): Promise<void> {
  try {
    await fn(type, msg);
  } catch (err) {
    logger.warn({ err }, "agent-loop: event emit failed");
  }
}

// Task #733: best-effort secret stripping for inline diff / command output
// events. We are conservative — better to redact a few false-positives than
// to leak a real key into the chat stream. The agent never sees these events
// (they only flow to the UI), so over-redacting has no downstream cost.
//
// Two layers of redaction:
//   1) The project's secret registry (decrypted values from project_secrets)
//      — authoritative literal match. Loaded once per project + cached for 5
//      minutes so we don't pay decryption cost on every event.
//   2) Conservative regex patterns for well-known secret shapes — catches
//      keys that came from outside the registry (env files printed by the
//      shell, AI-generated tokens, etc).
type SecretRegistryEntry = { values: string[]; expiresAt: number };
const SECRET_REGISTRY_CACHE = new Map<number, SecretRegistryEntry>();
const SECRET_REGISTRY_PENDING = new Map<number, Promise<string[]>>();
const SECRET_REGISTRY_TTL_MS = 5 * 60_000;

async function loadProjectSecretLiterals(projectId: number): Promise<string[]> {
  const now = Date.now();
  const cached = SECRET_REGISTRY_CACHE.get(projectId);
  if (cached && cached.expiresAt > now) return cached.values;
  const pending = SECRET_REGISTRY_PENDING.get(projectId);
  if (pending) return pending;
  const p = (async (): Promise<string[]> => {
    try {
      const { db: _db, secretsTable } = await import("@workspace/db");
      const { eq } = await import("drizzle-orm");
      const rows = await _db
        .select({ valueEncrypted: secretsTable.valueEncrypted })
        .from(secretsTable)
        .where(eq(secretsTable.projectId, projectId));
      const { encryptionService } = await import("./encryption");
      const values: string[] = [];
      for (const row of rows) {
        try {
          const v = encryptionService.decrypt(row.valueEncrypted);
          // Only redact values that are non-trivially long — short values
          // (e.g. "dev", "true") would cause far too many false positives.
          if (v && v.length >= 6) values.push(v);
        } catch {
          // skip malformed
        }
      }
      SECRET_REGISTRY_CACHE.set(projectId, {
        values,
        expiresAt: Date.now() + SECRET_REGISTRY_TTL_MS,
      });
      return values;
    } catch (err) {
      logger.warn({ err, projectId }, "agent-loop: secret registry load failed");
      return [];
    } finally {
      SECRET_REGISTRY_PENDING.delete(projectId);
    }
  })();
  SECRET_REGISTRY_PENDING.set(projectId, p);
  return p;
}

function escapeForRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const SECRET_PATTERNS: RegExp[] = [
  // AWS-style
  /AKIA[0-9A-Z]{16}/g,
  // GitHub PAT
  /ghp_[A-Za-z0-9]{20,}/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  // Stripe live keys
  /sk_live_[A-Za-z0-9]{16,}/g,
  /rk_live_[A-Za-z0-9]{16,}/g,
  // OpenAI
  /sk-[A-Za-z0-9_-]{20,}/g,
  // Slack
  /xox[abprs]-[A-Za-z0-9-]{10,}/g,
  // Generic bearer
  /Bearer\s+[A-Za-z0-9._\-+/=]{20,}/gi,
  // KEY=value style env assignments for likely-secret keys
  /\b([A-Z][A-Z0-9_]*(?:KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL|API|DSN))\s*=\s*([^\s"']{6,})/g,
  // JWTs
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
];

/**
 * Task #743 — produce a compact, JSON-safe object form of tool args for the
 * `tool_call` SSE event. We keep the shape so the UI can render structured
 * key/value rows, but cap individual string fields and the total payload to
 * avoid streaming megabytes of inlined HTML/source through the event bus.
 */
/**
 * Task #743 — tools that already emit richer dedicated SSE events
 * (file_diff, command_output, creative previews, narration on
 * report_progress/finalize). For these, the agent loop SKIPS the generic
 * `tool_call` event so the chat UI doesn't double-render them.
 */
export const TOOL_CALL_DEDICATED_EVENTS: ReadonlySet<string> = new Set([
  "write_file",
  "apply_patch",
  "delete_file",
  "run_command",
  "generate_image",
  "generate_video",
  "generate_audio",
  "remove_image_background",
  "report_progress",
  "finalize",
]);

export function shouldEmitToolCallEvent(toolName: string): boolean {
  return !TOOL_CALL_DEDICATED_EVENTS.has(toolName);
}

export type ToolCallEventPayload = {
  tool: string;
  args: Record<string, unknown>;
  ok: boolean;
  durationMs: number;
  preview: string;
};

/**
 * Task #743 — build the JSON payload streamed as a `tool_call` SSE event.
 * Args are run through the size-capped truncator; preview is the first
 * ~400 chars of the (already-redacted) observation.
 */
export function buildToolCallEventPayload(
  toolName: string,
  redactedArgs: Record<string, unknown>,
  ok: boolean,
  durationMs: number,
  observation: string,
): ToolCallEventPayload {
  return {
    tool: toolName,
    args: truncateArgsObject(redactedArgs),
    ok,
    durationMs,
    preview: typeof observation === "string" ? observation.slice(0, 400) : "",
  };
}

function truncateArgsObject(
  args: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  if (!args || typeof args !== "object") return {};
  const out: Record<string, unknown> = {};
  let budget = 1200;
  for (const [k, v] of Object.entries(args)) {
    if (budget <= 0) {
      out["…"] = "(truncated)";
      break;
    }
    if (typeof v === "string") {
      const cap = Math.min(200, budget);
      out[k] = v.length > cap ? v.slice(0, cap) + "…" : v;
      budget -= (out[k] as string).length + k.length + 4;
    } else if (v === null || typeof v === "number" || typeof v === "boolean") {
      out[k] = v;
      budget -= String(v).length + k.length + 4;
    } else {
      try {
        const json = JSON.stringify(v);
        const cap = Math.min(200, budget);
        out[k] = json.length > cap ? json.slice(0, cap) + "…" : json;
        budget -= (out[k] as string).length + k.length + 4;
      } catch {
        out[k] = "[unserializable]";
        budget -= k.length + 20;
      }
    }
  }
  return out;
}

function redactSecrets(text: string, literals: readonly string[] = []): string {
  let out = text;
  // Pass 1: authoritative registry — exact-match decrypted project secret
  // values. Replace the longest values first so a key whose value is a
  // substring of another isn't double-redacted.
  if (literals.length > 0) {
    const sorted = [...literals].sort((a, b) => b.length - a.length);
    for (const v of sorted) {
      if (!v) continue;
      out = out.split(v).join("[REDACTED]");
    }
  }
  // Pass 2: shape-based fallback.
  for (const re of SECRET_PATTERNS) {
    out = out.replace(re, (_m, k: string | undefined) => (k ? `${k}=[REDACTED]` : "[REDACTED]"));
  }
  return out;
}

// Ordered, LCS-based line diff. Produces a unified-style body with context
// (`  line`), additions (`+ line`), and removals (`- line`) in source order,
// so repeated or reordered lines aren't conflated. Bounded at 2000 lines per
// side to keep DP cost (O(n*m)) negligible — larger inputs are truncated and
// the cap downstream (FILE_DIFF_CAP) further bounds the emitted body.
function computeLineDiff(
  before: string,
  after: string,
): { diff: string; added: number; removed: number } {
  const MAX_LINES = 2000;
  const a = before.split("\n").slice(0, MAX_LINES);
  const b = after.split("\n").slice(0, MAX_LINES);
  const n = a.length;
  const m = b.length;
  // dp[i][j] = LCS length of a[i..] vs b[j..]
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const lines: string[] = [];
  let added = 0;
  let removed = 0;
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      lines.push(`  ${a[i]}`);
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      lines.push(`- ${a[i]}`);
      removed++;
      i++;
    } else {
      lines.push(`+ ${b[j]}`);
      added++;
      j++;
    }
  }
  while (i < n) {
    lines.push(`- ${a[i++]}`);
    removed++;
  }
  while (j < m) {
    lines.push(`+ ${b[j++]}`);
    added++;
  }
  return { diff: lines.join("\n"), added, removed };
}

const FILE_DIFF_CAP = 8 * 1024;
const COMMAND_OUTPUT_CAP = 16 * 1024;
const THINKING_CAP = 320;

async function emitFileDiffEvent(
  fn: AgentLoopEvent,
  projectId: number,
  payload: {
    path: string;
    op: "write" | "patch" | "delete";
    before: string;
    after: string;
  },
): Promise<void> {
  try {
    let added = 0;
    let removed = 0;
    let diffBody = "";
    if (payload.op === "delete") {
      removed = payload.before ? payload.before.split("\n").length : 0;
      diffBody = payload.before
        .split("\n")
        .map((l) => `- ${l}`)
        .join("\n");
    } else {
      const r = computeLineDiff(payload.before, payload.after);
      diffBody = r.diff;
      added = r.added;
      removed = r.removed;
    }
    const literals = await loadProjectSecretLiterals(projectId);
    diffBody = redactSecrets(diffBody, literals);
    let truncated = false;
    if (diffBody.length > FILE_DIFF_CAP) {
      diffBody = diffBody.slice(0, FILE_DIFF_CAP);
      truncated = true;
    }
    const msg = JSON.stringify({
      path: payload.path,
      op: payload.op,
      added,
      removed,
      diff: diffBody,
      truncated,
    });
    await fn("file_diff", msg);
  } catch (err) {
    logger.warn({ err }, "agent-loop: file_diff emit failed");
  }
}

/**
 * Stable key for grouping the start + final chunks of one command on the
 * client. The frontend uses this to dedupe / replace cards as the command
 * progresses from "running" → "final".
 */
function commandRunKey(argv: string[], startedAt: number): string {
  return `${startedAt}:${argv.slice(0, 4).join(" ").slice(0, 80)}`;
}

/**
 * Task #733: emit a "start" chunk for a command. The frontend renders a
 * "running…" card immediately so the user sees activity before the command
 * returns. Fly's exec API does not stream chunks, so we get one start event
 * up-front and a single final event when the call returns — but the payload
 * shape is streaming-ready (seq + status) so we can swap in a chunked
 * provider later without breaking the contract.
 */
/**
 * Single-quote escape a shell argument for safe embedding in `sh -c "..."`.
 * Closes the quote, inserts an escaped single quote, reopens. Bulletproof
 * against arbitrary content.
 */
function shSingleQuote(arg: string): string {
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

/**
 * Task #733: emit an interim chunk while the command is still running.
 * Carries the new tail of stdout (combined with stderr via the wrapping
 * `2>&1` shell) so the bubble can append to the live card incrementally.
 */
async function emitCommandChunkEvent(
  fn: AgentLoopEvent,
  projectId: number,
  payload: { runId: string; argv: string[]; seq: number; text: string },
): Promise<void> {
  try {
    const literals = await loadProjectSecretLiterals(projectId);
    let text = redactSecrets(payload.text ?? "", literals);
    let truncated = false;
    if (text.length > COMMAND_OUTPUT_CAP) {
      text = text.slice(-COMMAND_OUTPUT_CAP);
      truncated = true;
    }
    const msg = JSON.stringify({
      runId: payload.runId,
      status: "chunk" as const,
      seq: payload.seq,
      argv: payload.argv.slice(0, 12).map((s) => String(s).slice(0, 200)),
      stdout: text,
      stderr: "",
      truncated,
    });
    await fn("command_output", msg);
  } catch (err) {
    logger.warn({ err }, "agent-loop: command_output chunk emit failed");
  }
}

async function emitCommandStartEvent(
  fn: AgentLoopEvent,
  payload: { runId: string; argv: string[]; startedAt: number },
): Promise<void> {
  try {
    const msg = JSON.stringify({
      runId: payload.runId,
      status: "running" as const,
      seq: 0,
      argv: payload.argv.slice(0, 12).map((s) => String(s).slice(0, 200)),
      startedAt: payload.startedAt,
    });
    await fn("command_output", msg);
  } catch (err) {
    logger.warn({ err }, "agent-loop: command_output start emit failed");
  }
}

async function emitCommandFinalEvent(
  fn: AgentLoopEvent,
  projectId: number,
  payload: {
    runId: string;
    argv: string[];
    exitCode: number;
    durationMs: number;
    stdout: string;
    stderr: string;
  },
): Promise<void> {
  try {
    const literals = await loadProjectSecretLiterals(projectId);
    let stdout = redactSecrets(payload.stdout ?? "", literals);
    let stderr = redactSecrets(payload.stderr ?? "", literals);
    let truncated = false;
    if (stdout.length > COMMAND_OUTPUT_CAP) {
      stdout = stdout.slice(0, COMMAND_OUTPUT_CAP);
      truncated = true;
    }
    if (stderr.length > COMMAND_OUTPUT_CAP) {
      stderr = stderr.slice(0, COMMAND_OUTPUT_CAP);
      truncated = true;
    }
    const msg = JSON.stringify({
      runId: payload.runId,
      status: "final" as const,
      seq: 1,
      argv: payload.argv.slice(0, 12).map((s) => String(s).slice(0, 200)),
      exitCode: payload.exitCode,
      durationMs: payload.durationMs,
      stdout,
      stderr,
      // Kept for backward compatibility with older clients that read `output`.
      output: [stdout, stderr].filter(Boolean).join("\n"),
      truncated,
    });
    await fn("command_output", msg);
  } catch (err) {
    logger.warn({ err }, "agent-loop: command_output final emit failed");
  }
}

async function emitThinkingEvent(fn: AgentLoopEvent, text: string): Promise<void> {
  if (!text) return;
  const cleaned = text.trim().replace(/\s+/g, " ").slice(0, THINKING_CAP);
  if (!cleaned) return;
  try {
    await fn("thinking", cleaned);
  } catch (err) {
    logger.warn({ err }, "agent-loop: thinking emit failed");
  }
}

/**
 * Best-effort extraction of the resolved version from a package manager's
 * stdout. Returns null when nothing matches — the structured tool result
 * still includes the raw output for the model to fall back on.
 */
function extractInstalledVersion(
  manager: "npm" | "pnpm" | "yarn" | "pip",
  pkg: string,
  output: string,
): string | null {
  const esc = pkg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const patterns: RegExp[] = [];
  if (manager === "npm" || manager === "pnpm" || manager === "yarn") {
    // "+ pkg@1.2.3", "added pkg@1.2.3", "pkg 1.2.3"
    patterns.push(new RegExp(`${esc}@(\\d[\\w.+\\-]*)`));
    patterns.push(new RegExp(`${esc}\\s+(\\d[\\w.+\\-]*)`));
  } else if (manager === "pip") {
    // "Successfully installed pkg-1.2.3"
    patterns.push(new RegExp(`Successfully installed[^\\n]*${esc}-(\\d[\\w.+\\-]*)`, "i"));
    patterns.push(new RegExp(`${esc}==(\\d[\\w.+\\-]*)`));
  }
  for (const p of patterns) {
    const m = output.match(p);
    if (m?.[1]) return m[1];
  }
  return null;
}

/** Detect lockfile mutation hints in manager output. Best-effort. */
function detectLockfileTouched(
  manager: "npm" | "pnpm" | "yarn" | "pip",
  output: string,
): { lockfile: string; touched: boolean } | null {
  const lockfile =
    manager === "npm"
      ? "package-lock.json"
      : manager === "pnpm"
        ? "pnpm-lock.yaml"
        : manager === "yarn"
          ? "yarn.lock"
          : null;
  if (!lockfile) return null;
  // Most managers mention writing/updating the lockfile or list "added N packages".
  const touched = /lock|added \d+ package|updated|wrote/i.test(output);
  return { lockfile, touched };
}

async function writeToolAudit(
  ctx: ToolCtx,
  row: {
    toolName: string;
    argv: string[];
    exitCode: number;
    durationMs: number;
    blocked: boolean;
    blockReason: string | null;
    stdoutTail: string;
    stderrTail: string;
  },
): Promise<void> {
  try {
    await db.insert(toolAuditTable).values({
      projectId: ctx.input.projectId,
      taskId: ctx.input.taskId ?? null,
      toolName: row.toolName,
      stack: ctx.stack,
      argv: row.argv,
      exitCode: row.exitCode,
      stdoutTail: row.stdoutTail.slice(0, 400),
      stderrTail: row.stderrTail.slice(0, 400),
      durationMs: row.durationMs,
      blocked: row.blocked,
      blockReason: row.blockReason,
      policyStrictness: ctx.input.policyStrictness ?? DEFAULT_POLICY_STRICTNESS,
    });
  } catch (err) {
    logger.warn({ err, projectId: ctx.input.projectId }, "tool_audit insert failed (non-fatal)");
  }
}

function redactArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (k === "content" || k === "new_text") {
      const s = typeof v === "string" ? v : JSON.stringify(v);
      out[k] = s.length > 200 ? `${s.slice(0, 200)}… (${s.length} chars)` : s;
    } else {
      out[k] = v;
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool executors
// ─────────────────────────────────────────────────────────────────────────────

export interface ToolCtx {
  name: string;
  args: Record<string, unknown>;
  workspace: FileWorkspace;
  stack: StackId;
  profile: { checks: CheckSpec[]; installCmd: string[] | null };
  input: AgentLoopInput;
  commandsRun: CommandRecord[];
  step: number;
  /** Mutable container state: id may be filled in via on-demand provisioning. */
  containerState: { id: string | null; installed: boolean };
  /** Per-loop cache of loaded skills — guarantees no double-count and a free
   *  cache hit if the model re-loads the same skill mid-run. */
  loadedSkills: Map<string, SkillManifest>;
  /** Task #542: MCP tool catalog discovered at loop start. Used by the
   *  `mcp__<server>__<tool>` dispatch case to find endpoint + auth header. */
  mcpToolsCatalog?: import("./mcp").McpTool[];
  /** Accumulator for run_e2e tool invocations. */
  e2eResults: E2eRunSummary[];
  /**
   * Task-level remaining screenshot byte budget (default 5MB), shared across
   * every E2E run in this loop (smoke, run_e2e tool, auto-fix re-run). Each
   * run decrements it by the sum of its base64-decoded screenshot sizes.
   */
  screenshotBudget: { remaining: number };
  /** Per-task budget for combined web sense calls (web_fetch + web_search +
   *  extract_branding). Default 20. Each call decrements by 1; calls past the
   *  budget return an ERROR observation without making the network request. */
  fetchBudget: { remaining: number };
  /** Mutable counters for Task #529 "Agent Senses" tools — used for the
   *  loop report and post-loop credit accounting (1 credit per 5 web calls). */
  senseCounts: {
    screenshot: number;
    webFetch: number;
    webSearch: number;
    branding: number;
    diagnostics: number;
  };
  /** Per-task budget for combined creative-pack calls (generate_image +
   *  generate_video + generate_audio + remove_image_background). Default 5.
   *  Calls past the budget return an ERROR observation without making the
   *  API request, mirroring fetchBudget. */
  creativeBudget: { remaining: number };
  /** Mutable counters for Task #530 "Agent Creative Pack" tools. */
  creativeCounts: {
    image: number;
    video: number;
    audio: number;
    bgRemoval: number;
  };
  /** Task #531: assets the agent surfaced via `present_asset`. */
  presentedAssets: Array<{
    path: string;
    name: string;
    sizeBytes: number;
    mimeType: string;
    description?: string;
  }>;
  /** Task #532: epoch ms when the loop started + the effective wall-clock cap
   *  for this run. Used by paused tools (user_query/request_secret) to bound
   *  their per-prompt timeout by the loop's remaining budget so a pause can
   *  never outlive the loop's hard ceiling from #509. */
  loopStartedAt: number;
  loopWallClockMs: number;
}

/**
 * Estimate the on-disk byte count of all screenshots in an E2E summary by
 * decoding base64 length back to bytes (length * 3/4, minus padding). Used
 * to keep a single shared 5MB cap across multiple E2E runs in one task.
 */
function estimateScreenshotBytes(summary: E2eRunSummary): number {
  let total = 0;
  for (const sc of summary.scenarios) {
    if (sc.screenshotBase64) {
      total += Math.floor(sc.screenshotBase64.length * 0.75);
    }
  }
  return total;
}

const E2E_ACTION_SET = new Set([
  "click",
  "fill",
  "expectVisible",
  "expectText",
  "waitFor",
  "noConsoleErrors",
]);

function normalizeScenario(raw: unknown): E2eScenario | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const name = typeof r.name === "string" ? r.name.slice(0, 120) : null;
  const stepsIn = Array.isArray(r.steps) ? r.steps : null;
  if (!name || !stepsIn) return null;
  const steps: E2eScenario["steps"] = [];
  for (const s of stepsIn.slice(0, 12)) {
    if (!s || typeof s !== "object") continue;
    const obj = s as Record<string, unknown>;
    const action = typeof obj.action === "string" ? obj.action : "";
    if (!E2E_ACTION_SET.has(action)) continue;
    const selector = typeof obj.selector === "string" ? obj.selector.slice(0, 200) : "";
    const value = typeof obj.value === "string" ? obj.value.slice(0, 200) : "";
    const timeoutMs =
      typeof obj.timeoutMs === "number"
        ? Math.min(30_000, Math.max(100, obj.timeoutMs))
        : undefined;
    const optional = obj.optional === true;
    switch (action) {
      case "click":
        if (!selector) continue;
        steps.push({ action: "click", selector, optional });
        break;
      case "fill":
        if (!selector) continue;
        steps.push({ action: "fill", selector, value });
        break;
      case "expectVisible":
        if (!selector) continue;
        steps.push({ action: "expectVisible", selector });
        break;
      case "expectText":
        if (!selector) continue;
        steps.push({ action: "expectText", selector, value });
        break;
      case "waitFor":
        if (!selector) continue;
        steps.push({ action: "waitFor", selector, timeoutMs });
        break;
      case "noConsoleErrors":
        steps.push({ action: "noConsoleErrors" });
        break;
    }
  }
  if (steps.length === 0) return null;
  return { name, source: "smoke", steps };
}

function renderE2eObservation(summary: E2eRunSummary): string {
  const header = summary.skippedReason
    ? `E2E skipped: ${summary.skippedReason}`
    : `E2E ${summary.passed} passed, ${summary.failed} failed (${summary.totalDurationMs}ms, target=${summary.targetUrl ?? "n/a"})`;
  if (summary.scenarios.length === 0) return header;
  const lines = summary.scenarios.map((s: E2eScenarioResult) => {
    const tag = s.passed ? "PASS" : "FAIL";
    const errs = s.consoleErrors.length > 0 ? ` consoleErrors=${s.consoleErrors.length}` : "";
    const net = s.networkFailures.length > 0 ? ` networkFailures=${s.networkFailures.length}` : "";
    return `  ${tag} ${s.name} — ${s.message.slice(0, 160)}${errs}${net}`;
  });
  const failures = summary.scenarios.filter((s) => !s.passed);
  const detail = failures.slice(0, 3).flatMap((s) => {
    const out: string[] = [];
    if (s.consoleErrors.length > 0) {
      out.push(`  ${s.name} console:\n    ${s.consoleErrors.slice(0, 3).join("\n    ")}`);
    }
    if (s.networkFailures.length > 0) {
      out.push(
        `  ${s.name} network:\n    ${s.networkFailures
          .slice(0, 3)
          .map((n) => `${n.status ?? "ERR"} ${n.url} ${n.message}`)
          .join("\n    ")}`,
      );
    }
    return out;
  });
  return [header, ...lines, ...(detail.length > 0 ? ["", ...detail] : [])].join("\n");
}

/**
 * Run a container exec with a hard timeout. The Fly exec API itself doesn't
 * surface AbortSignal, but we race the promise against a wall-clock and the
 * caller's signal so the loop can move on (the container-side command will
 * keep running until Fly's own 5-minute server-side timeout — that's
 * acceptable; we just stop waiting for it).
 */
async function execWithTimeout(
  containerId: string,
  argv: string[],
  projectId: number,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<{
  ok: boolean;
  output: string;
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
  aborted: boolean;
}> {
  const { execInContainer } = await import("./container");
  let timer: NodeJS.Timeout | null = null;
  const timeoutPromise = new Promise<{
    ok: false;
    output: string;
    stdout: string;
    stderr: string;
    exitCode: number;
    timedOut: true;
    aborted: false;
  }>((resolve) => {
    timer = setTimeout(
      () =>
        resolve({
          ok: false,
          output: `timeout after ${timeoutMs}ms`,
          stdout: "",
          stderr: `timeout after ${timeoutMs}ms`,
          exitCode: 124,
          timedOut: true,
          aborted: false,
        }),
      Math.max(1_000, timeoutMs),
    );
  });
  const abortPromise = new Promise<{
    ok: false;
    output: string;
    stdout: string;
    stderr: string;
    exitCode: number;
    timedOut: false;
    aborted: true;
  }>((resolve) => {
    const onAbort = () =>
      resolve({
        ok: false,
        output: "aborted by user",
        stdout: "",
        stderr: "aborted by user",
        exitCode: 130,
        timedOut: false,
        aborted: true,
      });
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    const realRun = execInContainer(containerId, argv, projectId).then((r) => ({
      ok: r.ok,
      output: r.output,
      stdout: r.stdout,
      stderr: r.stderr,
      exitCode: r.exitCode,
      timedOut: false as const,
      aborted: false as const,
    }));
    return await Promise.race([realRun, timeoutPromise, abortPromise]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Provision a container on demand for stacks that need a shell. No-op if Fly isn't configured. */
async function ensureContainerProvisioned(ctx: ToolCtx): Promise<{ ok: boolean; reason?: string }> {
  if (ctx.containerState.id) return { ok: true };
  try {
    const { provisionContainer } = await import("./container");
    const files = ctx.workspace.all().map((f) => ({ path: f.path, content: f.content }));
    const info = await provisionContainer(ctx.input.projectId, files);
    if (!info?.containerId) {
      return { ok: false, reason: "container provider not configured (FLY_API_TOKEN unset)" };
    }
    ctx.containerState.id = info.containerId;
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: String((err as Error).message ?? err).slice(0, 200) };
  }
}

/** Run the stack's install command exactly once per loop, lazily on first shell use. */
async function ensureInstalled(ctx: ToolCtx, signal: AbortSignal, step: number): Promise<void> {
  if (ctx.containerState.installed) return;
  if (!ctx.profile.installCmd) {
    ctx.containerState.installed = true;
    return;
  }
  if (!ctx.containerState.id) return;
  const argv = ctx.profile.installCmd;
  await safeEvent(ctx.input.onEvent, "narration", "Installing dependencies…");
  const t = Date.now();
  const r = await execWithTimeout(
    ctx.containerState.id,
    argv,
    ctx.input.projectId,
    5 * 60_000,
    signal,
  );
  ctx.commandsRun.push({
    step,
    argv,
    exitCode: r.ok ? 0 : 1,
    durationMs: Date.now() - t,
    stdoutPreview: r.ok ? r.output.slice(0, 400) : "",
    stderrPreview: r.ok ? "" : r.output.slice(0, 400),
  });
  ctx.containerState.installed = true;
}

/**
 * Charge the billing hook once per 5 combined web-sense calls. Called after
 * each increment so usage is metered at-time-of-use, not only on success.
 */
function maybeChargeSenseBatch(ctx: ToolCtx): void {
  if (!ctx.input.onBillableSenseBatch) return;
  const total = ctx.senseCounts.webFetch + ctx.senseCounts.webSearch + ctx.senseCounts.branding;
  if (total > 0 && total % 5 === 0) {
    try {
      ctx.input.onBillableSenseBatch(1, total);
    } catch {
      // billing must not break the loop
    }
  }
}

export async function executeTool(ctx: ToolCtx): Promise<{
  ok: boolean;
  observation: string;
  noTruncate?: boolean;
  imageBase64?: string;
  imageMimeType?: string;
}> {
  const { name, args, workspace, stack, input, commandsRun, step, containerState } = ctx;
  if (input.signal.aborted) {
    return { ok: false, observation: "ERROR: aborted by user" };
  }
  // Task #542: MCP tool dispatch. Names take the form `mcp__<server>__<tool>`
  // and are looked up in the per-loop catalog so we can proxy the call via
  // JSON-RPC to the registered MCP server.
  if (name.startsWith("mcp__")) {
    const tool = ctx.mcpToolsCatalog?.find((t) => t.agentName === name);
    if (!tool) {
      return { ok: false, observation: `ERROR: MCP tool '${name}' not registered` };
    }
    try {
      const { callMcpTool } = await import("./mcp");
      const r = await callMcpTool(tool, args);
      if (!r.ok) {
        return { ok: false, observation: `ERROR: MCP call failed — ${r.error ?? "unknown"}` };
      }
      return { ok: true, observation: JSON.stringify(r.result).slice(0, 8000) };
    } catch (err) {
      return { ok: false, observation: `ERROR: MCP dispatch failed — ${(err as Error).message}` };
    }
  }
  switch (name) {
    case "list_uploads": {
      try {
        const { db, projectUploadsTable } = await import("@workspace/db");
        const { eq, desc } = await import("drizzle-orm");
        const rows = await db
          .select()
          .from(projectUploadsTable)
          .where(eq(projectUploadsTable.projectId, input.projectId))
          .orderBy(desc(projectUploadsTable.createdAt));
        if (rows.length === 0) return { ok: true, observation: "(no uploads)" };
        const summary = rows
          .map(
            (r) =>
              `#${r.id}  ${r.filename}  (${r.mimeType}, ${r.sizeBytes} bytes${r.textPreview ? ", textPreview" : ""})`,
          )
          .join("\n");
        return { ok: true, observation: summary };
      } catch (err) {
        return {
          ok: false,
          observation: `ERROR: list_uploads failed — ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    }
    case "read_inbox": {
      try {
        const { db, agentInboxTable } = await import("@workspace/db");
        const { and, eq, desc, inArray } = await import("drizzle-orm");
        const includeRead = args.include_read === true;
        const where = includeRead
          ? and(
              eq(agentInboxTable.projectId, input.projectId),
              inArray(agentInboxTable.status, ["unread", "read"]),
            )
          : and(
              eq(agentInboxTable.projectId, input.projectId),
              eq(agentInboxTable.status, "unread"),
            );
        const rows = await db
          .select()
          .from(agentInboxTable)
          .where(where)
          .orderBy(desc(agentInboxTable.createdAt))
          .limit(50);
        if (rows.length === 0) {
          return { ok: true, observation: "(no feedback items)" };
        }
        const unreadIds = rows.filter((r) => r.status === "unread").map((r) => r.id);
        if (unreadIds.length > 0) {
          await db
            .update(agentInboxTable)
            .set({ status: "read", readAt: new Date() })
            .where(inArray(agentInboxTable.id, unreadIds));
        }
        const summary = rows
          .map((r) => {
            const screenshot = r.screenshotUrl ? `\n  screenshot: ${r.screenshotUrl}` : "";
            const desc =
              r.description.length > 1200 ? r.description.slice(0, 1200) + "…" : r.description;
            return `#${r.id} [${r.severity}/${r.category}] (${r.status}) — ${desc}${screenshot}`;
          })
          .join("\n\n");
        return { ok: true, observation: summary };
      } catch (err) {
        return {
          ok: false,
          observation: `ERROR: read_inbox failed — ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    }
    case "read_upload": {
      const id = typeof args.id === "number" ? Math.floor(args.id) : NaN;
      if (!Number.isFinite(id)) return { ok: false, observation: "ERROR: id is required" };
      try {
        const { db, projectUploadsTable } = await import("@workspace/db");
        const { and, eq } = await import("drizzle-orm");
        const [row] = await db
          .select()
          .from(projectUploadsTable)
          .where(
            and(eq(projectUploadsTable.id, id), eq(projectUploadsTable.projectId, input.projectId)),
          );
        if (!row) return { ok: false, observation: `ERROR: upload #${id} not found` };
        if (row.textPreview) {
          const header = `[upload #${row.id} — ${row.filename} (${row.mimeType}, ${row.sizeBytes} bytes)]\n`;
          return { ok: true, observation: header + row.textPreview };
        }
        return {
          ok: true,
          observation: `[upload #${row.id} — ${row.filename}] Binary content (${row.mimeType}, ${row.sizeBytes} bytes). No text preview available. PDF/image parsing is not enabled in this build.`,
        };
      } catch (err) {
        return {
          ok: false,
          observation: `ERROR: read_upload failed — ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    }
    case "list_files": {
      const list = workspace.list();
      return { ok: true, observation: list.length === 0 ? "(no files)" : list.join("\n") };
    }
    case "read_file": {
      const path = sanitizePath(args.path);
      if (!path) return { ok: false, observation: "ERROR: invalid path" };
      const f = workspace.read(path);
      if (!f) return { ok: false, observation: `ERROR: file not found: ${path}` };
      const lines = f.content.split("\n");
      const totalLines = lines.length;
      const rawOffset = typeof args.offset === "number" ? Math.floor(args.offset) : 1;
      const rawLimit =
        typeof args.limit === "number" ? Math.floor(args.limit) : Number.MAX_SAFE_INTEGER;
      const offset = Math.max(1, Math.min(rawOffset, totalLines));
      const limit = Math.max(1, rawLimit);
      const endLine = Math.min(totalLines, offset + limit - 1);
      const slice = lines.slice(offset - 1, endLine).join("\n");
      const paged = offset > 1 || endLine < totalLines;
      let body = slice;
      // Byte-cap even paginated slices so a single huge line can't blow past
      // MAX_FILE_BYTES — model is told the byte truncation happened too.
      let byteTruncated = false;
      if (body.length > MAX_FILE_BYTES) {
        body = body.slice(0, MAX_FILE_BYTES);
        byteTruncated = true;
      }
      const header = paged
        ? `[showing lines ${offset}–${endLine} of ${totalLines}${byteTruncated ? `, byte-truncated to ${MAX_FILE_BYTES}` : ""}]\n`
        : byteTruncated
          ? `[byte-truncated to ${MAX_FILE_BYTES} of ${f.content.length} total bytes]\n`
          : "";
      return { ok: true, observation: header + body };
    }
    case "write_file": {
      const path = sanitizePath(args.path);
      if (!path) return { ok: false, observation: "ERROR: invalid path" };
      const content = typeof args.content === "string" ? args.content : "";
      if (content.length === 0) {
        return {
          ok: false,
          observation:
            "ERROR: content is empty — provide the actual file content. " +
            "If the file is large, write it in smaller sections using apply_patch, " +
            "or split it into multiple files.",
        };
      }
      if (content.length > MAX_FILE_BYTES * 4) {
        return { ok: false, observation: `ERROR: content too large (${content.length} bytes)` };
      }
      const mime = typeof args.mime_type === "string" ? args.mime_type : undefined;
      const prior = workspace.read(path)?.content ?? "";
      workspace.write(path, content, mime);
      void invalidateEmbeddingSafe(input.projectId, path);
      // Task #733: emit a file_diff event so the chat bubble can render an
      // inline diff. Stripped of secrets, capped to 8KB inside the emitter.
      void emitFileDiffEvent(input.onEvent, input.projectId, {
        path,
        op: "write",
        before: prior,
        after: content,
      });
      if (containerState.id) {
        try {
          const { writeFileToContainer } = await import("./container");
          await writeFileToContainer(containerState.id, path, content, input.projectId);
        } catch (err) {
          logger.warn({ err, path }, "agent-loop: container write failed (non-fatal)");
        }
      }
      return { ok: true, observation: `wrote ${path} (${content.length} bytes)` };
    }
    case "apply_patch": {
      const path = sanitizePath(args.path);
      if (!path) return { ok: false, observation: "ERROR: invalid path" };
      const oldText = typeof args.old_text === "string" ? args.old_text : "";
      const newText = typeof args.new_text === "string" ? args.new_text : "";
      const f = workspace.read(path);
      if (!f) return { ok: false, observation: `ERROR: file not found: ${path}` };
      if (oldText.length === 0)
        return { ok: false, observation: "ERROR: old_text must be non-empty" };
      const idx = f.content.indexOf(oldText);
      if (idx === -1) return { ok: false, observation: "ERROR: old_text not found in file" };
      if (f.content.indexOf(oldText, idx + 1) !== -1) {
        return {
          ok: false,
          observation: "ERROR: old_text matches multiple locations — include more context",
        };
      }
      const next = f.content.slice(0, idx) + newText + f.content.slice(idx + oldText.length);
      workspace.write(path, next, f.mimeType);
      void invalidateEmbeddingSafe(input.projectId, path);
      // Task #733: apply_patch has an exact before/after pair already, so the
      // diff is just `- oldText\n+ newText` rather than a bag-of-lines reduce.
      void emitFileDiffEvent(input.onEvent, input.projectId, {
        path,
        op: "patch",
        before: oldText,
        after: newText,
      });
      if (containerState.id) {
        try {
          const { writeFileToContainer } = await import("./container");
          await writeFileToContainer(containerState.id, path, next, input.projectId);
        } catch (err) {
          logger.warn({ err, path }, "agent-loop: container write failed (non-fatal)");
        }
      }
      return { ok: true, observation: `patched ${path}` };
    }
    case "delete_file": {
      const path = sanitizePath(args.path);
      if (!path) return { ok: false, observation: "ERROR: invalid path" };
      const priorFile = workspace.read(path);
      const removed = workspace.delete(path);
      if (!removed) return { ok: false, observation: `ERROR: file not found: ${path}` };
      void invalidateEmbeddingSafe(input.projectId, path);
      // Task #733: surface a delete file_diff so the chat bubble can show
      // the removed lines (capped/redacted by the emitter).
      void emitFileDiffEvent(input.onEvent, input.projectId, {
        path,
        op: "delete",
        before: priorFile?.content ?? "",
        after: "",
      });
      if (containerState.id) {
        try {
          // Direct argv (no shell wrapper) — sanitizePath already rejected any
          // shell metacharacters, but using argv form means even a sanitization
          // bypass cannot trigger command substitution.
          await execWithTimeout(
            containerState.id,
            ["rm", "-f", "--", `/app/${path}`],
            input.projectId,
            15_000,
            input.signal,
          );
        } catch (err) {
          logger.warn({ err, path }, "agent-loop: container delete failed (non-fatal)");
        }
      }
      return { ok: true, observation: `deleted ${path}` };
    }
    case "search": {
      const query = typeof args.query === "string" ? args.query : "";
      if (query.length === 0) return { ok: false, observation: "ERROR: empty query" };
      const hits = workspace.search(query);
      return { ok: true, observation: hits.length === 0 ? "(no matches)" : hits.join("\n") };
    }
    case "semantic_search": {
      const query = typeof args.query === "string" ? args.query.trim() : "";
      if (query.length === 0) return { ok: false, observation: "ERROR: empty query" };
      if (query.length > 400) {
        return { ok: false, observation: "ERROR: query too long (max 400 chars)" };
      }
      const topK = typeof args.top_k === "number" ? Math.floor(args.top_k) : 8;
      try {
        const { semanticSearch } = await import("./project-search");
        const files = workspace.all().map((f) => ({ path: f.path, content: f.content }));
        const hits = await semanticSearch(input.projectId, query, files, topK);
        if (hits.length === 0) return { ok: true, observation: "(no matches)" };
        const formatted = hits
          .map((h, i) => `${i + 1}. ${h.path}  (score: ${h.score.toFixed(3)})\n   ${h.snippet}`)
          .join("\n");
        return { ok: true, observation: formatted };
      } catch (err) {
        logger.warn({ err }, "semantic_search failed");
        return {
          ok: false,
          observation: `ERROR: semantic_search failed: ${(err as Error).message}`,
        };
      }
    }
    case "find_files": {
      const pattern = typeof args.pattern === "string" ? args.pattern.trim() : "";
      if (pattern.length === 0) return { ok: false, observation: "ERROR: empty pattern" };
      if (pattern.length > 200) {
        return { ok: false, observation: "ERROR: pattern too long (max 200 chars)" };
      }
      try {
        const { matchGlob } = await import("./project-search");
        const entries = workspace.listWithMtimes();
        const matched = matchGlob(
          pattern,
          entries.map((e) => e.path),
        );
        const matchedSet = new Set(matched);
        // Sort matches by mtime DESC (most-recently modified first), tiebreak
        // alphabetically — matches Replit Agent's `find_files` contract.
        const hits = entries
          .filter((e) => matchedSet.has(e.path))
          .sort((a, b) => b.mtime - a.mtime || a.path.localeCompare(b.path))
          .map((e) => e.path);
        return {
          ok: true,
          observation: hits.length === 0 ? "(no matches)" : hits.join("\n"),
        };
      } catch (err) {
        return { ok: false, observation: `ERROR: find_files failed: ${(err as Error).message}` };
      }
    }
    case "run_command": {
      const argv = Array.isArray(args.argv) ? (args.argv as unknown[]).map(String) : [];
      // In-process validators bypass the shell command policy entirely — they are
      // the documented mechanism for static-html / mobile-cross stacks. Validate
      // that the argv exactly matches one of the stack's declared check argvs.
      if (argv[0] === "__inprocess__") {
        const matches = ctx.profile.checks.some(
          (c) => c.argv.length === argv.length && c.argv.every((tok, i) => tok === argv[i]),
        );
        if (!matches) {
          return {
            ok: false,
            observation:
              "ERROR: __inprocess__ argv must exactly match one of this stack's declared check argvs",
          };
        }
        const kind = argv[1] ?? "";
        const t = Date.now();
        const r = runInprocessValidator(kind, workspace.all());
        commandsRun.push({
          step,
          argv,
          exitCode: r.exitCode,
          durationMs: Date.now() - t,
          stdoutPreview: r.output.slice(0, 400),
          stderrPreview: "",
        });
        return {
          ok: r.exitCode === 0,
          observation: `[${kind}] exit=${r.exitCode}\n${r.output}`,
        };
      }
      const strictness = ctx.input.policyStrictness ?? DEFAULT_POLICY_STRICTNESS;
      const check = evaluateRunCommand(argv, strictness, {
        allowedExactArgvs: ctx.profile.checks.map((c) => c.argv),
        installCmd: ctx.profile.installCmd,
      });
      if (!check.ok) {
        const reason = check.reason ?? "not allowed";
        const rec: CommandRecord = {
          step,
          argv,
          exitCode: 126,
          durationMs: 0,
          stdoutPreview: "",
          stderrPreview: `BLOCKED: ${reason}`,
        };
        commandsRun.push(rec);
        await writeToolAudit(ctx, {
          toolName: "run_command",
          argv,
          exitCode: 126,
          durationMs: 0,
          blocked: true,
          blockReason: reason,
          stdoutTail: "",
          stderrTail: `BLOCKED: ${reason}`,
        });
        return {
          ok: false,
          observation: JSON.stringify({
            blocked: true,
            reason,
            policyStrictness: strictness,
            argv,
          }),
        };
      }
      // In-process magic prefix
      if (argv[0] === "__inprocess__") {
        const kind = argv[1] ?? "";
        const t = Date.now();
        const r = runInprocessValidator(kind, workspace.all());
        commandsRun.push({
          step,
          argv,
          exitCode: r.exitCode,
          durationMs: Date.now() - t,
          stdoutPreview: r.output.slice(0, 400),
          stderrPreview: "",
        });
        return {
          ok: r.exitCode === 0,
          observation: `[${kind}] exit=${r.exitCode}\n${r.output}`,
        };
      }
      // Static / mobile stacks have no container shell
      if (stack === "static-html" || stack === "mobile-cross") {
        return {
          ok: false,
          observation:
            "ERROR: shell commands are not available for this stack. Use argv ['__inprocess__','<check-id>'] to run an in-process validator instead.",
        };
      }
      // On-demand container provisioning
      if (!containerState.id) {
        const prov = await ensureContainerProvisioned(ctx);
        if (!prov.ok) {
          return {
            ok: false,
            observation: `ERROR: cannot provision container: ${prov.reason ?? "unknown"}`,
          };
        }
      }
      // Human-in-the-loop approval gate — opt-in via requireCommandApproval.
      // Runs BEFORE ensureInstalled so no side-effects occur on rejection.
      if (input.requireCommandApproval && input.taskId) {
        const fullCmd = argv.join(" ");
        const { createPrompt } = await import("./agent-prompts");
        const remainingMs = Math.max(1_000, ctx.loopWallClockMs - (Date.now() - ctx.loopStartedAt));
        const promptTimeoutMs = Math.min(5 * 60_000, remainingMs);
        const approvalPayload = {
          question: `Allow the agent to run this command?\n\`${fullCmd}\``,
          kind: "boolean" as const,
          options: [],
          allowMultiple: false,
        };
        const { promptId, promise } = createPrompt({
          taskId: input.taskId,
          projectId: input.projectId,
          kind: "user_query",
          payload: approvalPayload,
          signal: input.signal,
          timeoutMs: promptTimeoutMs,
        });
        await safeEvent(
          input.onEvent,
          "agent_prompt",
          JSON.stringify({ promptId, kind: "user_query", payload: approvalPayload }),
        );
        const resp = await promise;
        if (resp.canceled) {
          // Both abort and wall-clock expiry terminate the task — never feed a
          // "timed out / rejected" observation back to the model (manual-only gate).
          throw new Error("Task terminated while awaiting command approval");
        }
        const approved =
          typeof resp.response === "boolean" ? resp.response : resp.response === "true";
        if (!approved) {
          return {
            ok: false,
            observation: "Command rejected by user — find an alternative approach",
          };
        }
      }

      // Install deps on first shell use (after approval so no side-effects on rejection)
      await ensureInstalled(ctx, input.signal, step);

      const timeoutMs =
        typeof args.timeout_ms === "number" && args.timeout_ms > 0
          ? Math.min(args.timeout_ms, PER_CALL_TIMEOUT_CAP_MS)
          : PER_CALL_TIMEOUT_DEFAULT_MS;
      const t = Date.now();
      // Task #733: emit a "running" chunk before the call so the chat bubble
      // can show the command as in-flight. Then wrap the argv in a shell
      // that tees combined stdout+stderr to a tmp log file and writes the
      // inner exit code to a sidecar file. While the wrapped exec is in
      // flight, a bounded poller tails the log and emits interim `chunk`
      // events so the bubble can render live output. On completion we read
      // the full log + parsed exit code, supersede the live card with a
      // `final` event, and best-effort cleanup the tmp files.
      const runId = commandRunKey(argv, t);
      await emitCommandStartEvent(input.onEvent, { runId, argv, startedAt: t });
      const { execInContainer } = await import("./container");
      const slug = `${t}_${Math.random().toString(36).slice(2, 8)}`;
      const logPath = `/tmp/agent-cmd-${slug}.log`;
      const exitPath = `/tmp/agent-cmd-${slug}.exit`;
      const escaped = argv.map(shSingleQuote).join(" ");
      const wrappedScript = `${escaped} > ${logPath} 2>&1; echo $? > ${exitPath}`;
      const wrappedArgv = ["sh", "-c", wrappedScript];

      // Live poller: starts after a 1.2s delay so fast commands incur zero
      // extra Fly API calls. Bounded at 10 polls (~12s of streaming) to cap
      // cost; the final event still carries the full captured output.
      let polling = true;
      let offset = 0;
      let chunkSeq = 1;
      const pollerPromise = (async () => {
        const pollEveryMs = 1200;
        const maxPolls = 10;
        for (let i = 0; i < maxPolls && polling; i++) {
          await new Promise((resolve) => setTimeout(resolve, pollEveryMs));
          if (!polling) break;
          try {
            const tailRes = await execInContainer(
              containerState.id!,
              ["sh", "-c", `tail -c +${offset + 1} ${logPath} 2>/dev/null || true`],
              input.projectId,
            );
            const newText = tailRes.stdout ?? "";
            if (newText.length > 0) {
              offset += newText.length;
              await emitCommandChunkEvent(input.onEvent, input.projectId, {
                runId,
                argv,
                seq: chunkSeq++,
                text: newText,
              });
            }
          } catch {
            // ignore poll failures — final event still has the full output
          }
        }
      })();

      const r = await execWithTimeout(
        containerState.id!,
        wrappedArgv,
        input.projectId,
        timeoutMs,
        input.signal,
      );
      polling = false;
      await pollerPromise;

      // Read full captured output + parsed inner exit code. We rely on a
      // separator to split log content from the exit file in a single exec
      // call (saves an RPC).
      let stdout = "";
      let exitCode = r.timedOut ? 124 : r.exitCode;
      try {
        const finalRead = await execInContainer(
          containerState.id!,
          [
            "sh",
            "-c",
            `cat ${logPath} 2>/dev/null; printf '\\n__AGENT_SEP__\\n'; cat ${exitPath} 2>/dev/null`,
          ],
          input.projectId,
        );
        const all = finalRead.stdout ?? "";
        const sepIdx = all.lastIndexOf("__AGENT_SEP__");
        if (sepIdx >= 0) {
          stdout = all.slice(0, sepIdx).replace(/\n$/, "");
          const exitStr = all.slice(sepIdx + "__AGENT_SEP__".length).trim();
          const parsed = parseInt(exitStr, 10);
          if (Number.isFinite(parsed) && !r.timedOut && !r.aborted) {
            exitCode = parsed;
          }
        } else {
          stdout = all;
        }
      } catch {
        // fall back to wrapper output if the read fails
        stdout = r.stdout ?? "";
      }
      // Best-effort cleanup; don't block on it.
      void execInContainer(
        containerState.id!,
        ["sh", "-c", `rm -f ${logPath} ${exitPath}`],
        input.projectId,
      ).catch(() => undefined);

      const dur = Date.now() - t;
      const stderr = "";
      const combined = stdout;
      const ok = !r.timedOut && !r.aborted && exitCode === 0;
      commandsRun.push({
        step,
        argv,
        exitCode,
        durationMs: dur,
        stdoutPreview: stdout.slice(0, 400),
        stderrPreview: stderr.slice(0, 400),
      });
      await writeToolAudit(ctx, {
        toolName: "run_command",
        argv,
        exitCode,
        durationMs: dur,
        blocked: false,
        blockReason: null,
        stdoutTail: stdout.slice(-400),
        stderrTail: stderr.slice(-400),
      });
      // Final chunk — emitted even on timeout/abort so the user can see what
      // got printed before the command was cut off.
      void emitCommandFinalEvent(input.onEvent, input.projectId, {
        runId,
        argv,
        exitCode,
        durationMs: dur,
        stdout,
        stderr,
      });
      if (r.aborted) return { ok: false, observation: "ERROR: aborted by user" };
      if (r.timedOut)
        return { ok: false, observation: `ERROR: command exceeded ${timeoutMs}ms timeout` };
      return {
        ok,
        observation: `exit=${exitCode}\n${combined.slice(0, MAX_OBSERVATION_CHARS)}`,
      };
    }
    case "run_workflow": {
      const name = typeof args.name === "string" ? args.name : "";
      if (!name) return { ok: false, observation: "ERROR: workflow name is required" };
      if (stack === "static-html" || stack === "mobile-cross") {
        return {
          ok: false,
          observation:
            "ERROR: workflows require a container shell, which this stack does not provide.",
        };
      }
      if (!containerState.id) {
        const prov = await ensureContainerProvisioned(ctx);
        if (!prov.ok) {
          return {
            ok: false,
            observation: `ERROR: cannot provision container: ${prov.reason ?? "unknown"}`,
          };
        }
      }
      await ensureInstalled(ctx, input.signal, step);
      try {
        const { findWorkflow } = await import("./workflows");
        const wf = await findWorkflow(input.projectId, name);
        if (!wf) {
          return {
            ok: false,
            observation: `ERROR: workflow "${name}" not found in workflows.yaml or stack defaults`,
          };
        }
        const cwd = wf.cwd ?? ".";
        const envPrefix = wf.env
          ? Object.entries(wf.env)
              .map(([k, v]) => `${k}='${String(v).replace(/'/g, "'\\''")}'`)
              .join(" ") + " "
          : "";
        const inner = `cd '${cwd.replace(/'/g, "'\\''")}' && ${envPrefix}${wf.command}`;
        const argv = ["sh", "-lc", inner];
        const timeoutMs =
          typeof args.timeout_ms === "number" && args.timeout_ms > 0
            ? Math.min(args.timeout_ms, PER_CALL_TIMEOUT_CAP_MS)
            : PER_CALL_TIMEOUT_DEFAULT_MS;
        const t = Date.now();
        const r = await execWithTimeout(
          containerState.id!,
          argv,
          input.projectId,
          timeoutMs,
          input.signal,
        );
        const dur = Date.now() - t;
        const exitCode = r.timedOut ? 124 : r.ok ? 0 : 1;
        commandsRun.push({
          step,
          argv,
          exitCode,
          durationMs: dur,
          stdoutPreview: r.ok ? r.output.slice(0, 400) : "",
          stderrPreview: r.ok ? "" : r.output.slice(0, 400),
        });
        if (r.aborted) return { ok: false, observation: "ERROR: aborted by user" };
        if (r.timedOut)
          return { ok: false, observation: `ERROR: workflow exceeded ${timeoutMs}ms timeout` };
        return {
          ok: r.ok,
          observation: `workflow[${wf.name}] exit=${exitCode}\n${r.output.slice(0, MAX_OBSERVATION_CHARS)}`,
        };
      } catch (err) {
        return {
          ok: false,
          observation: `ERROR: workflow run failed: ${(err as Error).message ?? String(err)}`,
        };
      }
    }
    case "pkg_install": {
      const strictness = ctx.input.policyStrictness ?? DEFAULT_POLICY_STRICTNESS;
      const decision = evaluatePkgInstall(
        { manager: args.manager, pkg: args.pkg, version: args.version },
        strictness,
      );
      if (!decision.ok) {
        const reason = decision.reason;
        await writeToolAudit(ctx, {
          toolName: "pkg_install",
          argv: [String(args.manager ?? "?"), String(args.pkg ?? "?"), String(args.version ?? "")],
          exitCode: 126,
          durationMs: 0,
          blocked: true,
          blockReason: reason,
          stdoutTail: "",
          stderrTail: `BLOCKED: ${reason}`,
        });
        return {
          ok: false,
          observation: JSON.stringify({
            blocked: true,
            reason,
            policyStrictness: strictness,
            manager: args.manager ?? null,
            pkg: args.pkg ?? null,
            version: args.version ?? null,
          }),
        };
      }
      if (stack === "static-html" || stack === "mobile-cross") {
        const reason = "pkg_install not available for this stack";
        await writeToolAudit(ctx, {
          toolName: "pkg_install",
          argv: decision.argv,
          exitCode: 126,
          durationMs: 0,
          blocked: true,
          blockReason: reason,
          stdoutTail: "",
          stderrTail: `BLOCKED: ${reason}`,
        });
        return {
          ok: false,
          observation: JSON.stringify({
            blocked: true,
            reason,
            policyStrictness: strictness,
            manager: decision.manager,
            pkg: decision.pkg,
            version: decision.version,
          }),
        };
      }
      if (!containerState.id) {
        const prov = await ensureContainerProvisioned(ctx);
        if (!prov.ok) {
          return {
            ok: false,
            observation: `ERROR: cannot provision container: ${prov.reason ?? "unknown"}`,
          };
        }
      }

      // Human-in-the-loop approval gate — opt-in via requireCommandApproval
      if (input.requireCommandApproval && input.taskId) {
        const pkgLabel = `${decision.pkg}${decision.version ? `@${decision.version}` : ""}`;
        const { createPrompt } = await import("./agent-prompts");
        const remainingMs = Math.max(1_000, ctx.loopWallClockMs - (Date.now() - ctx.loopStartedAt));
        const promptTimeoutMs = Math.min(5 * 60_000, remainingMs);
        const approvalPayload = {
          question: `Allow the agent to install package \`${pkgLabel}\` via ${decision.manager}?`,
          kind: "boolean" as const,
          options: [],
          allowMultiple: false,
        };
        const { promptId, promise } = createPrompt({
          taskId: input.taskId,
          projectId: input.projectId,
          kind: "user_query",
          payload: approvalPayload,
          signal: input.signal,
          timeoutMs: promptTimeoutMs,
        });
        await safeEvent(
          input.onEvent,
          "agent_prompt",
          JSON.stringify({ promptId, kind: "user_query", payload: approvalPayload }),
        );
        const resp = await promise;
        if (resp.canceled) {
          // Both abort and wall-clock expiry terminate the task — manual-only gate.
          throw new Error("Task terminated while awaiting package installation approval");
        }
        const approved =
          typeof resp.response === "boolean" ? resp.response : resp.response === "true";
        if (!approved) {
          return {
            ok: false,
            observation: "Package installation rejected by user — find an alternative approach",
          };
        }
      }

      await safeEvent(
        input.onEvent,
        "narration",
        `Installing ${decision.pkg}${decision.version ? `@${decision.version}` : ""} via ${decision.manager}…`,
      );
      const t = Date.now();
      const r = await execWithTimeout(
        containerState.id!,
        decision.argv,
        input.projectId,
        PKG_INSTALL_TIMEOUT_MS,
        input.signal,
      );
      const dur = Date.now() - t;
      const exitCode = r.timedOut ? 124 : r.ok ? 0 : 1;
      commandsRun.push({
        step,
        argv: decision.argv,
        exitCode,
        durationMs: dur,
        stdoutPreview: r.ok ? r.output.slice(0, 400) : "",
        stderrPreview: r.ok ? "" : r.output.slice(0, 400),
      });
      await writeToolAudit(ctx, {
        toolName: "pkg_install",
        argv: decision.argv,
        exitCode,
        durationMs: dur,
        blocked: false,
        blockReason: null,
        stdoutTail: r.ok ? r.output.slice(-400) : "",
        stderrTail: r.ok ? "" : r.output.slice(-400),
      });
      if (r.aborted) return { ok: false, observation: "ERROR: aborted by user" };
      if (r.timedOut)
        return {
          ok: false,
          observation: JSON.stringify({
            ok: false,
            manager: decision.manager,
            pkg: decision.pkg,
            requestedVersion: decision.version || null,
            installedVersion: null,
            lockfileDelta: null,
            exitCode,
            timedOut: true,
            error: `pkg_install exceeded ${PKG_INSTALL_TIMEOUT_MS}ms timeout`,
          }),
        };
      // Best-effort: extract the resolved/installed version from the manager
      // output (npm/pnpm/pip all print it). Lockfile delta is left null when
      // we can't cheaply diff it — the model can call list_files on the
      // lockfile if it needs more detail.
      const installedVersion = extractInstalledVersion(decision.manager, decision.pkg, r.output);
      const lockfileDelta = detectLockfileTouched(decision.manager, r.output);
      return {
        ok: r.ok,
        observation: JSON.stringify({
          ok: r.ok,
          manager: decision.manager,
          pkg: decision.pkg,
          requestedVersion: decision.version || null,
          installedVersion,
          lockfileDelta,
          exitCode,
          timedOut: false,
          output: r.output.slice(0, MAX_OBSERVATION_CHARS),
        }),
      };
    }
    case "report_progress": {
      return { ok: true, observation: "ok" };
    }
    case "fetch_prod_logs": {
      try {
        const { listProdLogs, listErrorGroups, latestHealthCheck } = await import("./prodLogs");
        const kindArg = typeof args.kind === "string" ? args.kind : "all";
        const limit = typeof args.limit === "number" ? Math.min(Math.max(args.limit, 1), 50) : 20;
        const kindFilter = kindArg === "all" ? undefined : kindArg;
        const [logs, groups, health] = await Promise.all([
          listProdLogs({ projectId: input.projectId, kind: kindFilter, limit }),
          listErrorGroups({ projectId: input.projectId, limit: 10 }),
          latestHealthCheck(input.projectId),
        ]);
        const compactLogs = logs.map((r) => ({
          ts: r.ts,
          kind: r.kind,
          method: r.method,
          path: r.path,
          status: r.status,
          latencyMs: r.latencyMs,
          errorClass: r.errorClass,
          message: r.message?.slice(0, 200) ?? null,
        }));
        const compactGroups = groups.map((g) => ({
          signature: g.signature,
          sample: g.sampleMessage?.slice(0, 200) ?? "",
          count: g.count,
          firstSeen: g.firstSeen,
          lastSeen: g.lastSeen,
        }));
        const payload = {
          logs: compactLogs,
          errorGroups: compactGroups,
          health: health
            ? {
                status: health.status,
                rootStatus: health.rootStatus,
                routesFailed: health.routesFailed,
                failureSummary: health.failureSummary,
                createdAt: health.createdAt,
              }
            : null,
          totals: { logs: compactLogs.length, groups: compactGroups.length },
        };
        return { ok: true, observation: JSON.stringify(payload) };
      } catch (err) {
        return {
          ok: false,
          observation: `ERROR: fetch_prod_logs failed: ${String((err as Error).message ?? err)}`,
        };
      }
    }
    case "author_skill": {
      const slug = typeof args.slug === "string" ? args.slug.trim().toLowerCase() : "";
      const description = typeof args.description === "string" ? args.description.trim() : "";
      const body = typeof args.body === "string" ? args.body : "";
      const name = typeof args.name === "string" && args.name.trim() ? args.name.trim() : slug;
      const triggers = Array.isArray(args.triggers)
        ? (args.triggers as unknown[]).map((t) => String(t))
        : [];
      const rationale = typeof args.rationale === "string" ? args.rationale : null;
      try {
        const result = await authorSkillDraft({
          slug,
          name,
          description,
          triggers,
          body,
          authoredBy: `agent:project-${input.projectId}`,
          authoringContext: rationale,
        });
        await safeEvent(
          input.onEvent,
          "narration",
          `Authored skill draft: ${result.name} (${result.bytes} bytes) — queued for admin review.`,
        );
        return {
          ok: true,
          observation: `Draft skill "${result.name}" written to skills/_drafts/${result.slug}/SKILL.md (${result.bytes} bytes). It is queued for admin review and will NOT appear in your skill index until approved. Do NOT call load_skill on it in this run.`,
        };
      } catch (err) {
        return {
          ok: false,
          observation: `ERROR: author_skill failed: ${String((err as Error).message ?? err)}`,
        };
      }
    }
    case "load_skill": {
      const skillName = typeof args.name === "string" ? args.name.trim() : "";
      if (!skillName) return { ok: false, observation: "ERROR: load_skill requires { name }" };
      if (skillName.length > 120) return { ok: false, observation: "ERROR: skill name too long" };
      const cached = ctx.loadedSkills.get(skillName);
      if (cached) {
        // Cache hit: do NOT re-emit the body — the original load is already in
        // conversation state, so re-injecting it would double-count tokens.
        return {
          ok: true,
          observation: `Skill "${skillName}" was already loaded earlier this run (${cached.body.length} bytes). The full body is already in your conversation context — scroll back to the earlier load_skill observation instead of reloading.`,
        };
      }
      const manifest = await loadSkillContent(skillName);
      if (!manifest) {
        return {
          ok: false,
          observation: `ERROR: skill "${skillName}" not found or disabled. Use a name listed in 'Available skills'.`,
        };
      }
      ctx.loadedSkills.set(skillName, manifest);
      return {
        ok: true,
        observation: `# Skill: ${manifest.name}\n${manifest.description}\n\n${manifest.body}`,
      };
    }
    case "run_e2e": {
      if (input.e2eEnabled === false) {
        return {
          ok: false,
          observation:
            "ERROR: E2E testing is disabled for this project (project.e2eEnabled=false).",
        };
      }
      const rawScenarios = Array.isArray(args.scenarios) ? (args.scenarios as unknown[]) : null;
      const scenarios: E2eScenario[] = rawScenarios
        ? rawScenarios.map((s) => normalizeScenario(s)).filter((s): s is E2eScenario => s !== null)
        : defaultSmokeScenarios();
      const fallbackHtml =
        stack === "static-html" ? (workspace.read("index.html")?.content ?? null) : null;
      const previewUrl = input.previewUrl ?? null;
      if (!previewUrl && !fallbackHtml) {
        return {
          ok: false,
          observation:
            "ERROR: no preview URL available — start the project's container before running E2E (or build a static-html project with index.html).",
        };
      }
      await safeEvent(input.onEvent, "narration", "Running Playwright E2E…");
      const summary = await runE2eScenarios({
        targetUrl: previewUrl,
        scenarios,
        fallbackHtml,
        maxScreenshotBytes: ctx.screenshotBudget.remaining,
        signal: input.signal,
      });
      ctx.screenshotBudget.remaining = Math.max(
        ctx.screenshotBudget.remaining - estimateScreenshotBytes(summary),
        0,
      );
      ctx.e2eResults.push(summary);
      const obs = renderE2eObservation(summary);
      return { ok: summary.failed === 0, observation: obs };
    }
    case "take_screenshot": {
      const { takeScreenshot } = await import("./agent-senses");
      const requestedUrl = typeof args.url === "string" && args.url.trim() ? args.url.trim() : null;
      const previewUrl = input.previewUrl ?? null;
      const fallbackHtml =
        stack === "static-html" ? (workspace.read("index.html")?.content ?? null) : null;
      const targetUrl = requestedUrl ?? previewUrl ?? "";
      if (!targetUrl && !fallbackHtml) {
        return {
          ok: false,
          observation:
            "ERROR: no URL or preview available. Pass `url` explicitly, or start the project container so a preview URL is available.",
        };
      }
      const sizeEstimate = 200_000; // rough guard before launch
      if (ctx.screenshotBudget.remaining < sizeEstimate) {
        return {
          ok: false,
          observation: `ERROR: screenshot budget exhausted (${ctx.screenshotBudget.remaining} bytes left).`,
        };
      }
      await safeEvent(
        input.onEvent,
        "take_screenshot",
        `Capturing screenshot of ${targetUrl || "preview"}…`,
      );
      const shot = await takeScreenshot({
        url: targetUrl,
        inlineHtml: !requestedUrl && !previewUrl ? (fallbackHtml ?? undefined) : undefined,
        width: typeof args.width === "number" ? args.width : undefined,
        height: typeof args.height === "number" ? args.height : undefined,
        fullPage: args.full_page === true,
        signal: input.signal,
      });
      ctx.senseCounts.screenshot += 1;
      if (!shot.ok) {
        return {
          ok: false,
          observation: `ERROR: take_screenshot failed: ${shot.error ?? "unknown"}`,
        };
      }
      const actualBytes = shot.bytes ?? 0;
      if (actualBytes > ctx.screenshotBudget.remaining) {
        // Reject: the capture exceeded the remaining budget. Do not deduct.
        return {
          ok: false,
          observation: `ERROR: screenshot (${actualBytes} bytes) exceeds remaining budget (${ctx.screenshotBudget.remaining} bytes). Reduce viewport size or skip full_page.`,
        };
      }
      ctx.screenshotBudget.remaining = Math.max(ctx.screenshotBudget.remaining - actualBytes, 0);
      // Task #533: return the base64 separately so the loop can attach it as
      // an image_url block on a follow-up user message and switch to the
      // provider's VISION_MODEL for the next turn. The tool observation
      // itself stays small (metadata only) — the image flows via the user
      // message that the loop appends after the tool response.
      return {
        ok: true,
        observation: JSON.stringify({
          url: targetUrl || "(inline)",
          bytes: shot.bytes ?? null,
          width: shot.width ?? null,
          height: shot.height ?? null,
          mimeType: "image/png",
          budgetRemaining: ctx.screenshotBudget.remaining,
          attachedToNextTurn: true,
        }),
        imageBase64: shot.base64 ?? undefined,
        imageMimeType: "image/png",
      };
    }
    case "web_fetch": {
      const { webFetch } = await import("./agent-senses");
      const url = typeof args.url === "string" ? args.url.trim() : "";
      if (!url) return { ok: false, observation: "ERROR: web_fetch requires { url }" };
      if (ctx.fetchBudget.remaining <= 0) {
        return {
          ok: false,
          observation: `ERROR: web sense budget exhausted (web_fetch + web_search + extract_branding). Limit is 20 calls per task.`,
        };
      }
      ctx.fetchBudget.remaining -= 1;
      await safeEvent(input.onEvent, "web_fetch", `Fetching ${url}…`);
      const r = await webFetch({ url, signal: input.signal });
      ctx.senseCounts.webFetch += 1;
      maybeChargeSenseBatch(ctx);
      if (!r.ok && r.status === 0) {
        return { ok: false, observation: `ERROR: web_fetch failed: ${r.error ?? "request error"}` };
      }
      return {
        ok: r.ok,
        observation: JSON.stringify({
          url: r.url,
          status: r.status,
          contentType: r.contentType,
          title: r.title ?? null,
          text: r.text ?? "",
        }),
      };
    }
    case "web_search": {
      const { webSearch } = await import("./agent-senses");
      const query = typeof args.query === "string" ? args.query.trim() : "";
      if (!query) return { ok: false, observation: "ERROR: web_search requires { query }" };
      if (ctx.fetchBudget.remaining <= 0) {
        return {
          ok: false,
          observation: `ERROR: web sense budget exhausted (web_fetch + web_search + extract_branding). Limit is 20 calls per task.`,
        };
      }
      ctx.fetchBudget.remaining -= 1;
      const limit = typeof args.limit === "number" ? args.limit : undefined;
      await safeEvent(input.onEvent, "web_search", `Searching: ${query.slice(0, 80)}`);
      const r = await webSearch({ query, limit, signal: input.signal });
      ctx.senseCounts.webSearch += 1;
      maybeChargeSenseBatch(ctx);
      if (!r.ok) {
        return {
          ok: false,
          observation: `ERROR: web_search (${r.provider}) — ${r.error ?? "no hits"}`,
        };
      }
      return {
        ok: true,
        observation: JSON.stringify({ provider: r.provider, hits: r.hits }),
      };
    }
    case "extract_branding": {
      const { extractBranding } = await import("./agent-senses");
      const url = typeof args.url === "string" ? args.url.trim() : "";
      if (!url) return { ok: false, observation: "ERROR: extract_branding requires { url }" };
      if (ctx.fetchBudget.remaining <= 0) {
        return {
          ok: false,
          observation: `ERROR: web sense budget exhausted (web_fetch + web_search + extract_branding). Limit is 20 calls per task.`,
        };
      }
      ctx.fetchBudget.remaining -= 1;
      await safeEvent(input.onEvent, "extract_branding", `Extracting brand from ${url}…`);
      const r = await extractBranding({ url, signal: input.signal });
      ctx.senseCounts.branding += 1;
      maybeChargeSenseBatch(ctx);
      if (!r.ok) {
        return {
          ok: false,
          observation: `ERROR: extract_branding failed: ${r.error ?? "unknown"}`,
        };
      }
      return {
        ok: true,
        observation: JSON.stringify({
          url: r.url,
          title: r.title,
          description: r.description,
          themeColor: r.themeColor,
          colors: r.colors,
          fonts: r.fonts,
          favicons: r.favicons,
          ogImage: r.ogImage,
        }),
      };
    }
    case "read_diagnostics": {
      const { readDiagnostics } = await import("./agent-senses");
      const path = typeof args.path === "string" ? args.path.trim() : "";
      if (!path) return { ok: false, observation: "ERROR: read_diagnostics requires { path }" };
      const toolArg =
        typeof args.tool === "string" &&
        ["tsc", "node", "python", "eslint", "auto"].includes(args.tool)
          ? (args.tool as "tsc" | "node" | "python" | "eslint" | "auto")
          : "auto";
      // On-demand container provisioning so the model can call this even
      // before any run_command has booted a container.
      if (!ctx.containerState.id) {
        const ensured = await ensureContainerProvisioned(ctx);
        if (!ensured.ok) {
          return {
            ok: false,
            observation: `ERROR: read_diagnostics needs a container — ${ensured.reason ?? "unavailable"}`,
          };
        }
      }
      await safeEvent(input.onEvent, "read_diagnostics", `Diagnostics → ${path}`);
      const r = await readDiagnostics({
        args: { path, tool: toolArg },
        containerId: ctx.containerState.id,
        projectId: input.projectId,
        signal: input.signal,
      });
      ctx.senseCounts.diagnostics += 1;
      if (!r.ok) {
        return { ok: false, observation: `ERROR: read_diagnostics: ${r.error ?? "unknown"}` };
      }
      return {
        ok: true,
        observation: JSON.stringify({
          tool: r.tool,
          path: r.path,
          diagnostics: r.diagnostics,
          rawTail: r.raw,
        }),
      };
    }
    case "generate_image":
    case "generate_video":
    case "generate_audio":
    case "remove_image_background":
      return executeCreativeTool(ctx);
    case "analyze_image": {
      // Task #665 — canonical analyze_image tool. Delegates to the shared
      // analyzeImagesToLayout helper so the agent-loop, the up-front
      // pre-pipeline analysis in jobs.ts, and any future caller all produce
      // identical layout briefs. Accepts either a workspace path or a URL.
      const path = typeof args.path === "string" ? sanitizePath(args.path) : null;
      const url = typeof args.url === "string" ? args.url.trim() : "";
      if (!path && !url) {
        return { ok: false, observation: "ERROR: analyze_image requires either `path` or `url`" };
      }
      let dataUri: string | null = null;
      if (path) {
        const f = workspace.read(path);
        if (!f) {
          return { ok: false, observation: `ERROR: file not found in workspace: ${path}` };
        }
        const mime = f.mimeType || guessMime(path);
        if (!/^image\/(png|jpeg|jpg|webp|gif)$/i.test(mime)) {
          return {
            ok: false,
            observation: `ERROR: ${path} is not an image (mime=${mime})`,
          };
        }
        // Workspace content is text-stored — if binary, the agent-loop encodes it
        // as base64 string. Assume the bytes are already a base64 string when
        // the mime is binary-image; otherwise utf-8 encode.
        const isLikelyBase64 = /^[A-Za-z0-9+/=\s]+$/.test(f.content) && f.content.length > 100;
        const b64 = isLikelyBase64
          ? f.content.replace(/\s+/g, "")
          : Buffer.from(f.content, "utf8").toString("base64");
        dataUri = `data:${mime};base64,${b64}`;
      } else if (url.startsWith("data:") || /^https?:\/\//i.test(url)) {
        dataUri = url;
      } else {
        return { ok: false, observation: "ERROR: url must be a data: URI or http(s) URL" };
      }
      const { analyzeImagesToLayout } = await import("./builder");
      const brief = await analyzeImagesToLayout([{ dataUri: dataUri! }], input.signal);
      if (!brief) {
        return {
          ok: false,
          observation: "ERROR: image analysis failed — vision call returned no content",
        };
      }
      await safeEvent(input.onEvent, "narration", "Image analysis complete.");
      return { ok: true, observation: brief };
    }
    case "present_asset": {
      const path = sanitizePath(args.path);
      if (!path) return { ok: false, observation: "ERROR: invalid path" };
      const f = workspace.read(path);
      if (!f) {
        return {
          ok: false,
          observation: `ERROR: file not found: ${path} — write the asset first with write_file`,
        };
      }
      const baseName = path.split("/").pop() || path;
      const rawName =
        typeof args.name === "string" && args.name.trim() ? args.name.trim() : baseName;
      const name = rawName.slice(0, 120);
      const description =
        typeof args.description === "string" && args.description.trim()
          ? args.description.trim().slice(0, 280)
          : undefined;
      const sizeBytes = Buffer.byteLength(f.content, "utf8");
      const mimeType = f.mimeType || guessMime(path);
      // Dedup by path — re-presenting an asset updates metadata instead of duplicating the card.
      const existingIdx = ctx.presentedAssets.findIndex((a) => a.path === path);
      const entry = { path, name, sizeBytes, mimeType, description };
      if (existingIdx >= 0) ctx.presentedAssets[existingIdx] = entry;
      else ctx.presentedAssets.push(entry);
      await safeEvent(input.onEvent, "narration", `Asset ready → ${name}`);
      return {
        ok: true,
        observation: `presented asset "${name}" (${path}, ${sizeBytes} bytes, ${mimeType})`,
      };
    }
    case "user_query": {
      const question = typeof args.question === "string" ? args.question.trim() : "";
      const kind = typeof args.kind === "string" ? args.kind : "";
      if (!question) {
        return { ok: false, observation: "ERROR: user_query requires a non-empty question" };
      }
      if (kind !== "choice" && kind !== "boolean" && kind !== "text") {
        return { ok: false, observation: "ERROR: kind must be one of choice|boolean|text" };
      }
      const rawOptions = Array.isArray(args.options) ? (args.options as unknown[]) : [];
      const options = rawOptions
        .map((o) => (typeof o === "string" ? o.trim().slice(0, 60) : ""))
        .filter((s) => s.length > 0)
        .slice(0, 6);
      if (kind === "choice" && options.length < 2) {
        return {
          ok: false,
          observation: "ERROR: kind=choice requires at least 2 non-empty options",
        };
      }
      const allowMultiple = kind === "choice" && args.allow_multiple === true;
      if (!input.taskId) {
        return { ok: false, observation: "ERROR: user_query requires an active task context" };
      }
      const { createPrompt } = await import("./agent-prompts");
      const payload = {
        question: question.slice(0, 500),
        kind,
        options: kind === "choice" ? options : [],
        allowMultiple,
      };
      // Skip window: min(5 min spec, remaining loop budget from #509). Short
      // prompt never strands a long-running task; long loop never extends
      // beyond the per-task wall-clock ceiling.
      const remainingMs = Math.max(1_000, ctx.loopWallClockMs - (Date.now() - ctx.loopStartedAt));
      const promptTimeoutMs = Math.min(5 * 60_000, remainingMs);
      const { promptId, promise } = createPrompt({
        taskId: input.taskId,
        projectId: input.projectId,
        kind: "user_query",
        payload,
        signal: input.signal,
        timeoutMs: promptTimeoutMs,
      });
      await safeEvent(
        input.onEvent,
        "agent_prompt",
        JSON.stringify({ promptId, kind: "user_query", payload }),
      );
      const resp = await promise;
      return { ok: true, observation: JSON.stringify({ kind, ...resp }) };
    }
    case "request_secret": {
      const name = typeof args.name === "string" ? args.name.trim() : "";
      if (!/^[A-Za-z_][A-Za-z0-9_]{0,80}$/.test(name)) {
        return {
          ok: false,
          observation: "ERROR: invalid secret name (use UPPER_SNAKE_CASE, ≤ 80 chars)",
        };
      }
      const category =
        typeof args.category === "string" &&
        ["api_key", "oauth", "webhook", "database", "other"].includes(args.category)
          ? args.category
          : "api_key";
      // Sanitize help_url: only http(s) schemes allowed (defense vs javascript:/data: XSS).
      let helpUrl: string | null = null;
      if (typeof args.help_url === "string") {
        const candidate = args.help_url.trim().slice(0, 500);
        try {
          const parsed = new URL(candidate);
          if (parsed.protocol === "http:" || parsed.protocol === "https:") {
            helpUrl = parsed.toString();
          }
        } catch {
          /* invalid URL → drop */
        }
      }
      const reason = typeof args.reason === "string" ? args.reason.trim().slice(0, 280) : null;
      if (!input.taskId) {
        return { ok: false, observation: "ERROR: request_secret requires an active task context" };
      }
      const { createPrompt } = await import("./agent-prompts");
      const payload = { name, category, helpUrl, reason };
      // Same min(5 min, remaining loop budget) cap as user_query.
      const remainingMs = Math.max(1_000, ctx.loopWallClockMs - (Date.now() - ctx.loopStartedAt));
      const promptTimeoutMs = Math.min(5 * 60_000, remainingMs);
      const { promptId, promise } = createPrompt({
        taskId: input.taskId,
        projectId: input.projectId,
        kind: "request_secret",
        payload,
        signal: input.signal,
        timeoutMs: promptTimeoutMs,
      });
      await safeEvent(
        input.onEvent,
        "agent_prompt",
        JSON.stringify({ promptId, kind: "request_secret", payload }),
      );
      const resp = await promise;
      return { ok: true, observation: JSON.stringify(resp) };
    }
    case "install_package": {
      const runtime = typeof args.runtime === "string" ? args.runtime : "";
      if (runtime !== "node" && runtime !== "python") {
        return { ok: false, observation: "ERROR: runtime must be 'node' or 'python'" };
      }
      const dev = args.dev === true;
      const manager = runtime === "node" ? "npm" : "pip";
      const strictness = ctx.input.policyStrictness ?? DEFAULT_POLICY_STRICTNESS;
      const decision = evaluatePkgInstall(
        { manager, pkg: args.name, version: args.version },
        strictness,
      );
      if (!decision.ok) {
        await writeToolAudit(ctx, {
          toolName: "install_package",
          argv: [runtime, String(args.name ?? "?"), String(args.version ?? "")],
          exitCode: 126,
          durationMs: 0,
          blocked: true,
          blockReason: decision.reason,
          stdoutTail: "",
          stderrTail: `BLOCKED: ${decision.reason}`,
        });
        return {
          ok: false,
          observation: JSON.stringify({
            blocked: true,
            reason: decision.reason,
            runtime,
            name: args.name ?? null,
            version: args.version ?? null,
          }),
        };
      }
      if (stack === "static-html" || stack === "mobile-cross") {
        const reason = "install_package not available for this stack";
        await writeToolAudit(ctx, {
          toolName: "install_package",
          argv: decision.argv,
          exitCode: 126,
          durationMs: 0,
          blocked: true,
          blockReason: reason,
          stdoutTail: "",
          stderrTail: `BLOCKED: ${reason}`,
        });
        return {
          ok: false,
          observation: JSON.stringify({
            blocked: true,
            reason,
            runtime,
            name: decision.pkg,
            version: decision.version,
          }),
        };
      }
      // Rewrite --save → --save-dev for npm devDependencies.
      const argv =
        dev && manager === "npm"
          ? decision.argv.map((tok) => (tok === "--save" ? "--save-dev" : tok))
          : decision.argv;
      if (!containerState.id) {
        const prov = await ensureContainerProvisioned(ctx);
        if (!prov.ok) {
          return {
            ok: false,
            observation: `ERROR: cannot provision container: ${prov.reason ?? "unknown"}`,
          };
        }
      }
      await safeEvent(
        input.onEvent,
        "narration",
        `Installing ${decision.pkg}${decision.version ? `@${decision.version}` : ""} via ${manager}${dev ? " (dev)" : ""}…`,
      );
      const t = Date.now();
      const r = await execWithTimeout(
        containerState.id!,
        argv,
        input.projectId,
        PKG_INSTALL_TIMEOUT_MS,
        input.signal,
      );
      const dur = Date.now() - t;
      const exitCode = r.timedOut ? 124 : r.ok ? 0 : 1;
      commandsRun.push({
        step,
        argv,
        exitCode,
        durationMs: dur,
        stdoutPreview: r.ok ? r.output.slice(0, 400) : "",
        stderrPreview: r.ok ? "" : r.output.slice(0, 400),
      });
      await writeToolAudit(ctx, {
        toolName: "install_package",
        argv,
        exitCode,
        durationMs: dur,
        blocked: false,
        blockReason: null,
        stdoutTail: r.ok ? r.output.slice(-400) : "",
        stderrTail: r.ok ? "" : r.output.slice(-400),
      });
      if (r.aborted) return { ok: false, observation: "ERROR: aborted by user" };
      if (r.timedOut) {
        return {
          ok: false,
          observation: JSON.stringify({
            ok: false,
            runtime,
            manager,
            name: decision.pkg,
            requestedVersion: decision.version || null,
            dev,
            exitCode,
            timedOut: true,
            error: `install exceeded ${PKG_INSTALL_TIMEOUT_MS}ms`,
          }),
        };
      }
      return {
        ok: r.ok,
        observation: JSON.stringify({
          ok: r.ok,
          runtime,
          manager,
          name: decision.pkg,
          requestedVersion: decision.version || null,
          installedVersion: extractInstalledVersion(manager, decision.pkg, r.output),
          dev,
          exitCode,
          output: r.output.slice(0, MAX_OBSERVATION_CHARS),
        }),
      };
    }
    case "suggest_deploy": {
      const environment = args.environment === "production" ? "production" : "testing";
      const note = typeof args.note === "string" ? args.note.trim().slice(0, 200) : null;
      const payload = { environment, note, projectId: input.projectId };
      // Fire-and-forget — does NOT pause the loop. The frontend listens for
      // "agent_prompt" SSE frames with kind="suggest_deploy" and renders a
      // one-click chip that triggers the existing publish flow.
      const promptId = `suggest-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      await safeEvent(
        input.onEvent,
        "agent_prompt",
        JSON.stringify({ promptId, kind: "suggest_deploy", payload }),
      );
      return {
        ok: true,
        observation: JSON.stringify({ suggested: true, environment, note }),
      };
    }
    case "threat_model": {
      const scope = typeof args.scope === "string" ? args.scope.trim().slice(0, 300) : "";
      if (!scope) return { ok: false, observation: "ERROR: scope is required" };
      const assumptions =
        typeof args.assumptions === "string" ? args.assumptions.trim().slice(0, 600) : "";
      try {
        const inventory = workspace
          .list()
          .slice(0, 80)
          .map((p) => `- ${p}`)
          .join("\n");
        const sys = `You are a senior application security engineer running a STRIDE threat model.
Return STRICT JSON with this shape:
{
  "scope": string,
  "assets": [{ "name": string, "description": string }],
  "trust_boundaries": [string],
  "threats": [{
    "category": "Spoofing" | "Tampering" | "Repudiation" | "InformationDisclosure" | "DenialOfService" | "ElevationOfPrivilege",
    "title": string,
    "description": string,
    "likelihood": "low" | "medium" | "high",
    "impact": "low" | "medium" | "high",
    "mitigations": [string]
  }],
  "summary": string
}
At least one threat per applicable STRIDE category. Be concrete, no boilerplate.`;
        const user = `Scope: ${scope}
${assumptions ? `\nAssumptions: ${assumptions}` : ""}

Project file inventory (truncated):
${inventory || "(empty workspace)"}`;
        const completion = await openai.chat.completions.create(
          {
            model: "gpt-5-mini",
            response_format: { type: "json_object" },
            messages: [
              { role: "system", content: sys },
              { role: "user", content: user },
            ],
          },
          { signal: input.signal },
        );
        const raw = completion.choices?.[0]?.message?.content ?? "{}";
        // Zod-validate the model output before persistence. Anything that
        // doesn't match the documented STRIDE shape is rejected with a
        // structured error so the caller (or operator) can see why.
        const ThreatModelSchema = z.object({
          scope: z.string().optional(),
          assets: z
            .array(
              z.object({
                name: z.string().optional(),
                description: z.string().optional(),
              }),
            )
            .optional(),
          trust_boundaries: z.array(z.string()).optional(),
          threats: z
            .array(
              z.object({
                category: z
                  .enum([
                    "Spoofing",
                    "Tampering",
                    "Repudiation",
                    "InformationDisclosure",
                    "DenialOfService",
                    "ElevationOfPrivilege",
                  ])
                  .optional(),
                title: z.string().optional(),
                description: z.string().optional(),
                likelihood: z.enum(["low", "medium", "high"]).optional(),
                impact: z.enum(["low", "medium", "high"]).optional(),
                mitigations: z.array(z.string()).optional(),
              }),
            )
            .optional(),
          summary: z.string().optional(),
        });
        let rawParsed: unknown;
        try {
          rawParsed = JSON.parse(raw);
        } catch {
          return { ok: false, observation: "ERROR: model returned invalid JSON" };
        }
        const validation = ThreatModelSchema.safeParse(rawParsed);
        if (!validation.success) {
          return {
            ok: false,
            observation: `ERROR: threat_model output failed schema validation — ${validation.error.message.slice(0, 400)}`,
          };
        }
        const parsed = validation.data;

        const md: string[] = [];
        md.push(`# Threat Model — ${parsed.scope ?? scope}`);
        md.push("");
        md.push(`_Generated by MustaFlow threat_model tool._`);
        md.push("");
        if (parsed.summary) {
          md.push(`## Summary`);
          md.push(parsed.summary);
          md.push("");
        }
        if (parsed.assets?.length) {
          md.push(`## Assets`);
          for (const a of parsed.assets) md.push(`- **${a.name ?? "?"}** — ${a.description ?? ""}`);
          md.push("");
        }
        if (parsed.trust_boundaries?.length) {
          md.push(`## Trust boundaries`);
          for (const t of parsed.trust_boundaries) md.push(`- ${t}`);
          md.push("");
        }
        if (parsed.threats?.length) {
          md.push(`## STRIDE threats`);
          for (const t of parsed.threats) {
            md.push(`### ${t.category ?? "?"} — ${t.title ?? "(untitled)"}`);
            md.push(`**Likelihood:** ${t.likelihood ?? "?"} · **Impact:** ${t.impact ?? "?"}`);
            if (t.description) md.push("");
            if (t.description) md.push(t.description);
            if (t.mitigations?.length) {
              md.push("");
              md.push("**Mitigations:**");
              for (const m of t.mitigations) md.push(`- ${m}`);
            }
            md.push("");
          }
        }
        const markdown = md.join("\n");
        workspace.write("threat_model.md", markdown, "text/markdown");

        // Best-effort Knowledge Vault write — never blocks the loop.
        try {
          const { writeKnowledge } = await import("./knowledge");
          await writeKnowledge({
            title: `Threat model: ${parsed.scope ?? scope}`,
            content: markdown.slice(0, 8000),
            type: "threat_model",
            category: "security",
            severity: "info",
            projectId: input.projectId,
            tags: ["threat_model", "stride", "security"],
            // Keep project-scoped: threat models contain project-specific
            // architecture details and mitigations that must not bleed into
            // other projects via cross-project knowledge retrieval.
            approvedForReuse: false,
          });
        } catch (err) {
          logger.warn({ err }, "threat_model: knowledge write failed (non-fatal)");
        }

        const threatCount = parsed.threats?.length ?? 0;
        return {
          ok: true,
          observation: `wrote threat_model.md (${markdown.length} bytes, ${threatCount} threats). Knowledge vault entry recorded.`,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { ok: false, observation: `ERROR: threat_model failed — ${msg}` };
      }
    }
    case "finalize": {
      return { ok: true, observation: "finalized" };
    }
    case "list_blueprints": {
      const { loadBlueprints } = await import("./blueprints");
      const manifests = await loadBlueprints();
      return {
        ok: true,
        observation: JSON.stringify(
          manifests.map((b) => ({
            id: b.id,
            name: b.name,
            category: b.category,
            description: b.description,
            requiredSecrets: b.requiredSecrets.map((s) => s.name),
            packageCount: b.packages.length,
            fileCount: b.files.length,
          })),
        ),
      };
    }
    case "install_blueprint": {
      const { findBlueprint, installBlueprint } = await import("./blueprints");
      const id = typeof args.id === "string" ? args.id : "";
      const overwrite = args.overwrite === true;
      if (!id) return { ok: false, observation: "ERROR: id is required" };
      const bp = await findBlueprint(id);
      if (!bp) return { ok: false, observation: `ERROR: blueprint '${id}' not found` };
      const { db: agentDb, projectsTable: agentProjectsTable } = await import("@workspace/db");
      const { eq: agentEq } = await import("drizzle-orm");
      const [proj] = await agentDb
        .select({ projectFormat: agentProjectsTable.projectFormat })
        .from(agentProjectsTable)
        .where(agentEq(agentProjectsTable.id, input.projectId));
      if (bp.mobileOnly && proj?.projectFormat !== "mobile-cross") {
        return {
          ok: false,
          observation: `ERROR: blueprint '${bp.id}' is mobile-only; this project is '${proj?.projectFormat ?? "unknown"}'`,
        };
      }
      if (bp.webOnly && proj?.projectFormat === "mobile-cross") {
        return {
          ok: false,
          observation: `ERROR: blueprint '${bp.id}' is web-only; cannot install into a mobile project`,
        };
      }
      const isContainerStack = !(stack === "static-html" || stack === "mobile-cross");
      try {
        const result = await installBlueprint(bp, {
          projectId: input.projectId,
          actor: null,
          overwrite,
          installPackages: isContainerStack
            ? async (pkgs) => {
                if (!containerState.id) {
                  const prov = await ensureContainerProvisioned(ctx);
                  if (!prov.ok) return;
                }
                const nodePkgs = pkgs.filter((p) => p.runtime === "node");
                if (nodePkgs.length === 0 || !containerState.id) return;
                const argv = [
                  "npm",
                  "install",
                  ...nodePkgs.map((p) => (p.version ? `${p.name}@${p.version}` : p.name)),
                ];
                await safeEvent(
                  input.onEvent,
                  "narration",
                  `Installing blueprint packages: ${nodePkgs.map((p) => p.name).join(", ")}`,
                );
                const t = Date.now();
                const r = await execWithTimeout(
                  containerState.id,
                  argv,
                  input.projectId,
                  PKG_INSTALL_TIMEOUT_MS,
                  input.signal,
                );
                commandsRun.push({
                  step,
                  argv,
                  exitCode: r.timedOut ? 124 : r.ok ? 0 : 1,
                  durationMs: Date.now() - t,
                  stdoutPreview: r.ok ? r.output.slice(0, 400) : "",
                  stderrPreview: r.ok ? "" : r.output.slice(0, 400),
                });
              }
            : undefined,
          requestSecrets: input.taskId
            ? async (secrets) => {
                const { createPrompt } = await import("./agent-prompts");
                const provided: string[] = [];
                for (const s of secrets) {
                  if (input.signal.aborted) break;
                  const remainingMs = Math.max(
                    1_000,
                    ctx.loopWallClockMs - (Date.now() - ctx.loopStartedAt),
                  );
                  const promptTimeoutMs = Math.min(5 * 60_000, remainingMs);
                  const payload = {
                    name: s.name,
                    category: s.category ?? "api_key",
                    helpUrl: s.helpUrl ?? null,
                    reason: s.reason ?? `Required by blueprint ${bp.id}`,
                  };
                  const { promptId, promise } = createPrompt({
                    taskId: input.taskId!,
                    projectId: input.projectId,
                    kind: "request_secret",
                    payload,
                    signal: input.signal,
                    timeoutMs: promptTimeoutMs,
                  });
                  await safeEvent(
                    input.onEvent,
                    "agent_prompt",
                    JSON.stringify({ promptId, kind: "request_secret", payload }),
                  );
                  try {
                    const resp = (await promise) as { provided?: boolean };
                    if (resp?.provided) provided.push(s.name);
                  } catch {
                    /* skip on cancel/timeout */
                  }
                }
                return provided;
              }
            : undefined,
        });
        // Mirror DB-installed blueprint files into the in-memory FileWorkspace
        // so the loop's end-of-job replace-all (writeFiles from workspace.all())
        // doesn't clobber files installBlueprint just wrote to project_files.
        const writtenSet = new Set(result.filesWritten);
        for (const f of bp.files) {
          if (!writtenSet.has(f.path)) continue;
          const mime = f.mimeType ?? "text/plain";
          ctx.workspace.write(f.path, f.content, mime);
        }
        return {
          ok: true,
          observation: JSON.stringify({
            installed: true,
            id: bp.id,
            filesWritten: result.filesWritten,
            filesSkipped: result.filesSkipped,
            requiredSecrets: bp.requiredSecrets.map((s) => ({
              name: s.name,
              category: s.category,
              optional: !!s.optional,
            })),
            packages: bp.packages,
            postInstallNotes: bp.postInstallNotes ?? null,
          }),
        };
      } catch (err) {
        return {
          ok: false,
          observation: `ERROR: install_blueprint failed — ${(err as Error).message}`,
        };
      }
    }
    case "dispatch_subagent": {
      const { dispatchSubagentFromTool } = await import("./subagent");
      return dispatchSubagentFromTool(ctx, args);
    }
    case "plan_subtasks": {
      const { planSubtasksFromTool } = await import("./subagent");
      return planSubtasksFromTool(ctx, args);
    }
    default:
      return { ok: false, observation: `ERROR: unknown tool: ${name}` };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Creative Pack (Task #530) — generate_image / video / audio / remove_image_background
// ─────────────────────────────────────────────────────────────────────────────

const CREATIVE_CREDIT_COST: Record<
  "generate_image" | "generate_video" | "generate_audio" | "remove_image_background",
  number
> = {
  generate_image: 1,
  generate_video: 3,
  generate_audio: 2,
  remove_image_background: 1,
};

async function executeCreativeTool(
  ctx: ToolCtx,
): Promise<{ ok: boolean; observation: string; noTruncate?: boolean }> {
  const { name, args, workspace, input, containerState } = ctx;
  const tool = name as
    | "generate_image"
    | "generate_video"
    | "generate_audio"
    | "remove_image_background";

  if (ctx.creativeBudget.remaining <= 0) {
    return {
      ok: false,
      observation:
        "ERROR: creative-pack budget exhausted (5 calls per task across generate_image + generate_video + generate_audio + remove_image_background).",
    };
  }

  const rawPath = sanitizePath(args.path);
  if (!rawPath) return { ok: false, observation: "ERROR: invalid path" };
  // Asset placement: default media outputs under assets/ unless the model
  // explicitly picked a recognized media folder. Keeps generated artifacts
  // organized predictably. remove_image_background reads an existing file,
  // so its input path is not rewritten — only the optional out_path is.
  const ASSET_FOLDERS = ["assets/", "public/", "static/", "src/assets/", "media/"];
  const isUnderAssets = (p: string) => ASSET_FOLDERS.some((f) => p.startsWith(f));
  const outPath =
    tool === "remove_image_background" || isUnderAssets(rawPath) || rawPath.includes("/")
      ? rawPath
      : `assets/${rawPath}`;

  const { generateImageAsset, generateVideoAsset, generateAudioAsset, removeImageBackgroundAsset } =
    await import("./agent-creative");

  // Lazy budget decrement: only counted when we actually start the call.
  ctx.creativeBudget.remaining -= 1;
  await safeEvent(input.onEvent, tool, `${tool.replace(/_/g, " ")} → ${outPath}`);
  const tool_ = tool; // capture for closure

  let result: Awaited<ReturnType<typeof generateImageAsset>>;
  let counterKey: "image" | "video" | "audio" | "bgRemoval";

  switch (tool) {
    case "generate_image": {
      const prompt = typeof args.prompt === "string" ? args.prompt : "";
      const size =
        args.size === "256x256" || args.size === "512x512" || args.size === "1024x1024"
          ? args.size
          : "1024x1024";
      result = await generateImageAsset({ prompt, size, signal: input.signal });
      counterKey = "image";
      break;
    }
    case "generate_video": {
      const prompt = typeof args.prompt === "string" ? args.prompt : "";
      const aspectRatio = args.aspect_ratio === "9:16" ? "9:16" : "16:9";
      const durationSeconds = typeof args.duration_seconds === "number" ? args.duration_seconds : 6;
      result = await generateVideoAsset({
        prompt,
        aspectRatio,
        durationSeconds,
        signal: input.signal,
      });
      counterKey = "video";
      break;
    }
    case "generate_audio": {
      const text = typeof args.text === "string" ? args.text : "";
      const voice = typeof args.voice === "string" ? args.voice : undefined;
      const format =
        args.format === "wav" || args.format === "opus" || args.format === "mp3"
          ? args.format
          : "mp3";
      result = await generateAudioAsset({ text, voice, format, signal: input.signal });
      counterKey = "audio";
      break;
    }
    case "remove_image_background": {
      const source = workspace.read(outPath);
      if (!source) {
        return { ok: false, observation: `ERROR: source image not found: ${outPath}` };
      }
      const srcMime = source.mimeType ?? guessMime(outPath);
      result = await removeImageBackgroundAsset({
        imageBase64: source.content,
        imageMimeType: srcMime,
        filename: outPath.split("/").pop() ?? "input.png",
        signal: input.signal,
      });
      counterKey = "bgRemoval";
      break;
    }
  }

  void tool_;
  if (!result.ok) {
    return {
      ok: false,
      observation: `ERROR: ${tool} failed: ${result.error}${result.notConfigured ? " (notConfigured)" : ""}`,
    };
  }

  // Decide where to write. generate_image writes to args.path. generate_audio
  // writes to args.path. remove_image_background writes to args.out_path (or
  // a sibling `.no-bg.png` next to args.path when omitted — overwriting the
  // source would mismatch the extension for .jpg/.webp inputs). generate_video
  // args.path — but it always fails today.
  let writePath = outPath;
  if (tool === "remove_image_background") {
    if (typeof args.out_path === "string") {
      const sanitized = sanitizePath(args.out_path);
      if (sanitized) writePath = sanitized;
    } else {
      // Default to a sibling `<stem>.no-bg.png` so a .jpg/.webp source isn't
      // overwritten with PNG bytes under the wrong extension.
      const dot = outPath.lastIndexOf(".");
      const slash = outPath.lastIndexOf("/");
      const stem = dot > slash ? outPath.slice(0, dot) : outPath;
      writePath = `${stem}.no-bg.png`;
    }
  }

  workspace.write(writePath, result.base64, result.mimeType);
  // NOTE: container sync intentionally skipped for binary creative writes.
  // `writeFileToContainer` re-encodes its `content` argument via
  // `Buffer.from(content, "utf8")`, which mangles non-UTF-8 bytes. Persistence
  // for binary creative assets happens through the snapshot path
  // (`serveSnapshot` decodes base64 when `isBinaryMime(mime)` is true), so the
  // generated asset is still served correctly by the published preview — only
  // the *live* container disk lacks the file until the next full sync. If a
  // container-side binary write is needed in the future, add a dedicated
  // `writeBinaryFileToContainer` helper rather than reusing the UTF-8 path.

  ctx.creativeCounts[counterKey] += 1;
  const credits = CREATIVE_CREDIT_COST[tool];
  if (input.onBillableCreativeCall) {
    try {
      input.onBillableCreativeCall(credits, tool);
    } catch {
      // billing must not break the loop
    }
  }

  // Emit a richer narration event carrying preview metadata so the chat UI
  // can render a thumbnail / asset card alongside the Sparkles icon. For
  // images we include a small data-URI thumbnail (capped at ~6KB of source
  // bytes encoded inline); for audio/video we ship path + size + MIME and
  // let the UI link to the served snapshot.
  const sizeKB = (result.bytes / 1024).toFixed(1);
  const isImage = result.mimeType.startsWith("image/");
  const previewDataUri =
    isImage && result.base64.length < 8_000
      ? `data:${result.mimeType};base64,${result.base64}`
      : null;
  const previewPayload = JSON.stringify({
    tool,
    path: writePath,
    mimeType: result.mimeType,
    sizeKB,
    previewDataUri,
  }).slice(0, 12_000);
  await safeEvent(input.onEvent, tool, previewPayload);

  return {
    ok: true,
    observation: JSON.stringify({
      tool,
      path: writePath,
      mimeType: result.mimeType,
      bytes: result.bytes,
      creditsCharged: credits,
      budgetRemaining: ctx.creativeBudget.remaining,
    }),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Post-loop check runner (always runs, populates CheckResultRecord[])
// ─────────────────────────────────────────────────────────────────────────────

async function runCheckProfile(
  checks: CheckSpec[],
  workspace: FileWorkspace,
  input: AgentLoopInput,
  containerState?: { id: string | null; installed: boolean },
  installCmd: string[] | null = null,
): Promise<CheckResultRecord[]> {
  const out: CheckResultRecord[] = [];
  // On-demand container provisioning for the check runner. If any check needs
  // a container and one isn't attached yet, provision it now (graceful no-op
  // if Fly isn't configured).
  const needsContainer = checks.some((c) => c.runner !== "inprocess");
  let effectiveContainerId = containerState?.id ?? input.containerId ?? null;
  if (needsContainer && !effectiveContainerId && !input.signal.aborted) {
    try {
      const { provisionContainer } = await import("./container");
      const files = workspace.all().map((f) => ({ path: f.path, content: f.content }));
      const info = await provisionContainer(input.projectId, files);
      if (info?.containerId) {
        effectiveContainerId = info.containerId;
        if (containerState) containerState.id = info.containerId;
      }
    } catch {
      // fall through; checks below will report a skipped/error result per check
    }
  }
  // Run installCmd once per loop before any container check so typecheck/build
  // don't fail just because node_modules is missing. installCmd is null for
  // pure in-process stacks.
  if (
    needsContainer &&
    effectiveContainerId &&
    installCmd &&
    containerState &&
    !containerState.installed &&
    !input.signal.aborted
  ) {
    try {
      await execWithTimeout(
        effectiveContainerId,
        installCmd,
        input.projectId,
        5 * 60_000,
        input.signal,
      );
    } catch {
      // continue; check failures will surface the real problem
    }
    containerState.installed = true;
  }
  for (const c of checks) {
    if (input.signal.aborted) {
      out.push({
        id: c.id,
        label: c.label,
        passed: false,
        durationMs: 0,
        message: "aborted",
      });
      continue;
    }
    const t = Date.now();
    if (c.runner === "inprocess") {
      const kind = c.argv[1] ?? "";
      const r = runInprocessValidator(kind, workspace.all());
      out.push({
        id: c.id,
        label: c.label,
        passed: r.exitCode === 0,
        durationMs: Date.now() - t,
        message: r.output.slice(0, 400),
      });
      continue;
    }
    if (!effectiveContainerId) {
      out.push({
        id: c.id,
        label: c.label,
        passed: false,
        durationMs: 0,
        message: "skipped: no container available (FLY_API_TOKEN unset?)",
      });
      continue;
    }
    try {
      // Use execWithTimeout so cancel propagates and stuck execs don't block
      // the loop indefinitely.
      const exec = await execWithTimeout(
        effectiveContainerId,
        c.argv,
        input.projectId,
        2 * 60_000,
        input.signal,
      );
      out.push({
        id: c.id,
        label: c.label,
        passed: exec.ok,
        durationMs: Date.now() - t,
        message: (exec.output ?? "").slice(-400),
      });
    } catch (err) {
      out.push({
        id: c.id,
        label: c.label,
        passed: false,
        durationMs: Date.now() - t,
        message: `error: ${String((err as Error).message ?? err)}`.slice(0, 400),
      });
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Adapter: convert AgentLoopResult into the shapes runJob already consumes
// ─────────────────────────────────────────────────────────────────────────────

export function loopResultToBuildResult(
  result: AgentLoopResult,
  userPrompt: string,
  projectName: string,
): BuilderResult {
  const baseReport = buildTaskReport(result, userPrompt);
  const blueprint: Blueprint = {
    projectName,
    projectType: result.loopReport.stack,
    targetPlatforms: [result.loopReport.stack === "mobile-cross" ? "mobile" : "web"],
    pages: [],
    components: [],
    integrationsNeeded: [],
  };
  return {
    files: result.files,
    blueprint,
    report: baseReport,
    assistantSummary: result.assistantSummary,
    correctionPasses: 0,
    // Hard gate: required-check failures must block the snapshot from being
    // saved as a successful build. runJob inspects correctionFailed and
    // refuses to persist files when it's true. Failure detail is still
    // recorded in report.agentLoop.checkResults for the chat narrative.
    correctionFailed: result.checksFailed,
    primaryErrorCategory: result.checksFailed ? "checks-failed" : null,
  };
}

export function loopResultToRefineResult(
  result: AgentLoopResult,
  userPrompt: string,
): {
  changedFiles: BuilderFile[];
  removedPaths: string[];
  unchangedFiles: string[];
  report: TaskReport;
  assistantSummary: string;
  correctionPasses: number;
  correctionFailed: boolean;
  primaryErrorCategory: string | null;
} {
  const baseReport = buildTaskReport(result, userPrompt);
  return {
    changedFiles: result.changedFiles,
    removedPaths: result.removedPaths,
    unchangedFiles: result.unchangedFiles,
    report: baseReport,
    assistantSummary: result.assistantSummary,
    correctionPasses: 0,
    // Hard gate (refine path): see comment on loopResultToBuildResult.
    correctionFailed: result.checksFailed,
    primaryErrorCategory: result.checksFailed ? "checks-failed" : null,
  };
}

function mergeUserResults(run: E2eRunSummary, userResults: E2eScenarioResult[]): void {
  if (userResults.length === 0) return;
  for (const r of userResults) {
    run.scenarios.push(r);
    if (r.message.startsWith("skipped")) run.skipped += 1;
    else if (r.passed) run.passed += 1;
    else run.failed += 1;
    run.totalDurationMs += r.durationMs;
  }
}

function buildTaskReport(result: AgentLoopResult, userRequest: string): TaskReport {
  const checkSummary =
    result.loopReport.checkResults.length === 0
      ? undefined
      : result.loopReport.checkResults
          .map((c) => `${c.passed ? "PASS" : "FAIL"} ${c.id}`)
          .join(", ");
  const failed = result.loopReport.checkResults.filter((c) => !c.passed).map((c) => c.id);
  const passed = result.loopReport.checkResults.filter((c) => c.passed).length;
  const warnings = [...result.warnings];
  if (result.loopReport.terminationReason !== "finalized") {
    warnings.push(`Agent loop terminated: ${result.loopReport.terminationReason}`);
  }
  return {
    userRequest,
    filesCreated: result.changedFiles.map((f) => f.path),
    filesChanged: [],
    filesRemoved: result.removedPaths,
    previewUpdated: result.changedFiles.length > 0 || result.removedPaths.length > 0,
    warnings,
    integrationsNeeded: [],
    summary: result.assistantSummary,
    checkSummary,
    checkRunsSummary: {
      passed,
      warnings: 0,
      failed: failed.length,
      skipped: 0,
      failedChecks: failed,
      warnChecks: [],
    },
    syntaxValid: !result.checksFailed,
    // Stash the full loop report on validationReport so the existing UI surfaces it,
    // and on a side channel via `summary` for now. Frontend can later read the raw
    // loopReport via the typed extension below.
    validationReport: {
      initialIssues: failed,
      fixupAttempted: result.loopReport.toolCalls.some(
        (t) => t.tool === "write_file" || t.tool === "apply_patch",
      ),
      remainingIssues: failed,
      passed: !result.checksFailed,
    },
    agentLoop: result.loopReport,
    e2eResults: result.loopReport.e2eResults ?? null,
    assets:
      result.loopReport.assets && result.loopReport.assets.length > 0
        ? result.loopReport.assets
        : undefined,
  };
}
