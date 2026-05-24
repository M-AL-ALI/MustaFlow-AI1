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
  onEvent: AgentLoopEvent;
  signal: AbortSignal;
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

const TOOLS: ChatCompletionTool[] = [
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
      description: "Read the full text content of one project file.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Relative path inside the project." },
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
        "Case-insensitive substring search across all current project files. Returns up to 50 matching lines with file:line prefix.",
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
  const strictness = input.policyStrictness ?? DEFAULT_POLICY_STRICTNESS;
  const platformNote = isStatic
    ? "This is a STATIC web app (HTML/CSS/JS + Tailwind/lucide via CDN). No npm or build tools — `run_command` is restricted to in-process validators."
    : isMobile
      ? "This is a MOBILE cross-platform app (Expo SDK 52 / Expo Router v3 / NativeWind v4). Generate an Expo project AND an index.html web preview. `run_command` is restricted to in-process structural validators."
      : `This is a ${stack} project running inside a Linux container. You may run shell commands (npm/npx/tsc/python/etc.) via run_command. To add new dependencies, prefer pkg_install over raw \`npm install\`.`;
  return [
    `You are MustaFlow's agentic app builder. Your job is to ${input.mode === "build" ? "create" : "refine"} a working ${stack} application that satisfies the user's request.`,
    "",
    platformNote,
    "",
    "## How you work",
    "- Use tools iteratively. Each turn, decide the next best action.",
    "- Read before you edit. Search before you guess.",
    "- Make small, focused changes. Prefer apply_patch for surgical edits, write_file for new/rewritten files.",
    "- After meaningful edits, run the checks for this stack to verify your work. Fix failures, then re-run.",
    "- Call `finalize` only after all required checks pass. Provide a short, accurate summary.",
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

class FileWorkspace {
  private files = new Map<string, BuilderFile>();
  private readonly initialPaths: Set<string>;

  constructor(initial: BuilderFile[]) {
    for (const f of initial) this.files.set(f.path, { ...f });
    this.initialPaths = new Set(initial.map((f) => f.path));
  }

  list(): string[] {
    return Array.from(this.files.keys()).sort();
  }

  read(path: string): BuilderFile | undefined {
    return this.files.get(path);
  }

  write(path: string, content: string, mimeType?: string): BuilderFile {
    const mt = mimeType ?? guessMime(path);
    const file: BuilderFile = { path, content, mimeType: mt };
    this.files.set(path, file);
    return file;
  }

  delete(path: string): boolean {
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

  // Per-task skill registry: load index for the system prompt, then cache
  // already-loaded skills in this Map so a repeated load_skill is a free
  // cache hit (no double-count, no second LLM trip into the body).
  const enabledSkills = await listEnabledSkills();
  const skillsIndex = formatSkillIndex(enabledSkills);
  const loadedSkills = new Map<string, SkillManifest>();

  const messages: ChatCompletionMessageParam[] = [
    { role: "system", content: buildSystemPrompt(input, stack, profile, skillsIndex) },
  ];

  // Seed context: current file manifest
  const seedManifest = workspace.list();
  messages.push({
    role: "user",
    content:
      `User request:\n${input.userPrompt}\n\n` +
      `Current files in project (${seedManifest.length}):\n${
        seedManifest.length > 0 ? seedManifest.slice(0, 40).join("\n") : "(empty)"
      }\n\n` +
      `Conversation history follows.`,
  });
  for (const turn of (input.conversationHistory ?? []).slice(-6)) {
    messages.push({ role: turn.role, content: turn.content });
  }

  const model = MODEL_FOR_MODE[input.agentMode] ?? "gpt-5-mini";
  const containerState = { id: input.containerId ?? null, installed: false };
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

    let response;
    try {
      response = await openai.chat.completions.create(
        {
          model,
          messages,
          tools: TOOLS,
          tool_choice: "auto",
        },
        { signal: input.signal },
      );
    } catch (err) {
      if (input.signal.aborted) {
        terminationReason = "aborted";
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

    if (toolReqs.length === 0) {
      // Model returned plain text; treat finish_reason=stop as "done without finalize".
      if (msg.content && msg.content.length > 0) {
        finalSummary = msg.content.slice(0, 600);
      }
      terminationReason = "model-stopped";
      break;
    }

    let stepFinalized = false;
    let mutatedThisTurn = false;
    for (const call of toolReqs) {
      if (call.type !== "function") continue;
      const name = call.function.name;
      let parsed: Record<string, unknown> = {};
      try {
        parsed = call.function.arguments ? JSON.parse(call.function.arguments) : {};
      } catch {
        parsed = {};
      }
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

      toolCalls.push({
        step,
        tool: name,
        args: redactArgs(parsed),
        ok: result.ok,
        durationMs,
        preview: observation.slice(0, 400),
      });

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

      // Enforce tool-call cap mid-turn — stop immediately if we hit the budget
      // partway through a multi-tool-call response.
      if (toolCalls.length >= STEP_CAP && name !== "finalize") {
        terminationReason = "step-cap";
        stepFinalized = true; // borrow flag to break the outer for-loop too
        break;
      }

      if (name === "finalize") {
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
          const fixResp = await openai.chat.completions.create(
            { model, messages, tools: TOOLS, tool_choice: "auto" },
            { signal: input.signal },
          );
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
): Promise<{ ok: boolean; output: string; timedOut: boolean; aborted: boolean }> {
  const { execInContainer } = await import("./container");
  let timer: NodeJS.Timeout | null = null;
  const timeoutPromise = new Promise<{ ok: false; output: string; timedOut: true; aborted: false }>(
    (resolve) => {
      timer = setTimeout(
        () =>
          resolve({
            ok: false,
            output: `timeout after ${timeoutMs}ms`,
            timedOut: true,
            aborted: false,
          }),
        Math.max(1_000, timeoutMs),
      );
    },
  );
  const abortPromise = new Promise<{ ok: false; output: string; timedOut: false; aborted: true }>(
    (resolve) => {
      const onAbort = () =>
        resolve({ ok: false, output: "aborted by user", timedOut: false, aborted: true });
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    },
  );
  try {
    const realRun = execInContainer(containerId, argv, projectId).then((r) => ({
      ok: r.ok,
      output: r.output,
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

export async function executeTool(
  ctx: ToolCtx,
): Promise<{ ok: boolean; observation: string; noTruncate?: boolean }> {
  const { name, args, workspace, stack, input, commandsRun, step, containerState } = ctx;
  if (input.signal.aborted) {
    return { ok: false, observation: "ERROR: aborted by user" };
  }
  switch (name) {
    case "list_files": {
      const list = workspace.list();
      return { ok: true, observation: list.length === 0 ? "(no files)" : list.join("\n") };
    }
    case "read_file": {
      const path = sanitizePath(args.path);
      if (!path) return { ok: false, observation: "ERROR: invalid path" };
      const f = workspace.read(path);
      if (!f) return { ok: false, observation: `ERROR: file not found: ${path}` };
      const content =
        f.content.length > MAX_FILE_BYTES
          ? `${f.content.slice(0, MAX_FILE_BYTES)}\n…(truncated, ${f.content.length} bytes total)`
          : f.content;
      return { ok: true, observation: content };
    }
    case "write_file": {
      const path = sanitizePath(args.path);
      if (!path) return { ok: false, observation: "ERROR: invalid path" };
      const content = typeof args.content === "string" ? args.content : "";
      if (content.length > MAX_FILE_BYTES * 4) {
        return { ok: false, observation: `ERROR: content too large (${content.length} bytes)` };
      }
      const mime = typeof args.mime_type === "string" ? args.mime_type : undefined;
      workspace.write(path, content, mime);
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
      const removed = workspace.delete(path);
      if (!removed) return { ok: false, observation: `ERROR: file not found: ${path}` };
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
      // Install deps on first shell use
      await ensureInstalled(ctx, input.signal, step);

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
      await writeToolAudit(ctx, {
        toolName: "run_command",
        argv,
        exitCode,
        durationMs: dur,
        blocked: false,
        blockReason: null,
        stdoutTail: r.ok ? r.output.slice(-400) : "",
        stderrTail: r.ok ? "" : r.output.slice(-400),
      });
      if (r.aborted) return { ok: false, observation: "ERROR: aborted by user" };
      if (r.timedOut)
        return { ok: false, observation: `ERROR: command exceeded ${timeoutMs}ms timeout` };
      return {
        ok: r.ok,
        observation: `exit=${exitCode}\n${r.output.slice(0, MAX_OBSERVATION_CHARS)}`,
      };
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
      // Return the full base64 PNG so vision-capable models can inspect the
      // image. Observation truncation at the loop level caps total size, but
      // we expose the whole image up to that cap so the model can actually
      // see what it rendered.
      return {
        ok: true,
        noTruncate: true,
        observation: JSON.stringify({
          url: targetUrl || "(inline)",
          bytes: shot.bytes ?? null,
          width: shot.width ?? null,
          height: shot.height ?? null,
          mimeType: "image/png",
          base64: shot.base64 ?? "",
          budgetRemaining: ctx.screenshotBudget.remaining,
        }),
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
    case "finalize": {
      return { ok: true, observation: "finalized" };
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
  // overwrites args.path when omitted). generate_video would write to
  // args.path — but it always fails today.
  let writePath = outPath;
  if (tool === "remove_image_background" && typeof args.out_path === "string") {
    const sanitized = sanitizePath(args.out_path);
    if (sanitized) writePath = sanitized;
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
  };
}
