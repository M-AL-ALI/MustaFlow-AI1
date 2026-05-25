import { useEffect, useRef, useState } from "react";
import {
  useListTasks,
  getListTasksQueryKey,
  useListVersions,
  getListVersionsQueryKey,
  usePatchVersion,
  useCancelTask,
  useForceStartTask,
} from "@workspace/api-client-react";
import { useTaskEventStream } from "@/hooks/use-task-event-stream";
import { useQueryClient } from "@tanstack/react-query";
import {
  Brain,
  BookOpen,
  Wrench,
  Code2,
  Save,
  ShieldCheck,
  GraduationCap,
  RefreshCw,
  CheckCircle2,
  XCircle,
  Clock,
  Loader2,
  ChevronDown,
  ChevronRight,
  Search,
  GitBranch,
  FilePen,
  Database,
  Camera,
  Globe,
  Palette,
  Sparkles,
  AlertCircle,
  Timer,
  Bookmark,
  Pencil,
  Check,
  X,
  ExternalLink,
  Square,
  BrainCircuit,
  TerminalSquare,
  EyeOff,
  Eye,
} from "lucide-react";
import { cn } from "@/lib/utils";

type StepEvent = {
  id: number;
  eventType: string;
  message: string;
  filePath?: string | null;
};

type StepGroup = {
  key: string;
  narration: string;
  steps: StepEvent[];
  isFinished: boolean;
};

const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);

const STEP_ICON: Record<string, React.ElementType> = {
  queued: Clock,
  analyzing_request: Search,
  loading_context: BookOpen,
  planning: Brain,
  planning_changes: GitBranch,
  reading_files: BookOpen,
  generating_code: Code2,
  editing_files: FilePen,
  saving_files: Database,
  validating_output: ShieldCheck,
  testing: ShieldCheck,
  fixing_errors: Wrench,
  updating_preview: RefreshCw,
  saving_version: Save,
  writing_lessons: GraduationCap,
  page_map_updated: RefreshCw,
  generating_blueprint: Brain,
  restoring_files: BookOpen,
  completed: CheckCircle2,
  failed: XCircle,
  take_screenshot: Camera,
  web_fetch: Globe,
  web_search: Search,
  extract_branding: Palette,
  read_diagnostics: AlertCircle,
  generate_image: Sparkles,
  generate_video: Sparkles,
  generate_audio: Sparkles,
  remove_image_background: Sparkles,
  file_diff: FilePen,
  command_output: TerminalSquare,
  thinking: BrainCircuit,
  tool_call: Wrench,
};

const STEP_COLOR: Record<string, string> = {
  queued: "text-muted-foreground",
  analyzing_request: "text-violet-400",
  loading_context: "text-blue-300",
  planning: "text-violet-400",
  planning_changes: "text-violet-300",
  reading_files: "text-blue-400",
  generating_code: "text-primary",
  editing_files: "text-yellow-400",
  saving_files: "text-yellow-300",
  validating_output: "text-cyan-300",
  testing: "text-cyan-400",
  fixing_errors: "text-orange-400",
  updating_preview: "text-sky-400",
  saving_version: "text-secondary",
  writing_lessons: "text-emerald-400",
  page_map_updated: "text-sky-300",
  generating_blueprint: "text-violet-400",
  restoring_files: "text-blue-400",
  completed: "text-green-400",
  failed: "text-destructive",
  file_diff: "text-yellow-400",
  command_output: "text-cyan-400",
  thinking: "text-violet-300",
  tool_call: "text-amber-300",
};

/**
 * Task #743 — `tool_call` payload emitted by the agentic loop for tools that
 * don't already have a dedicated event type (web_search results, take_screenshot,
 * read_diagnostics, etc.). Renders as a collapsible row with args + truncated
 * preview output.
 */
type ToolCallPayload = {
  tool: string;
  args: Record<string, unknown>;
  ok: boolean;
  durationMs: number;
  preview: string;
};
function parseToolCall(eventType: string, message: string): ToolCallPayload | null {
  if (eventType !== "tool_call") return null;
  if (!message || !message.startsWith("{")) return null;
  try {
    const obj = JSON.parse(message) as Partial<ToolCallPayload>;
    if (typeof obj.tool !== "string") return null;
    return {
      tool: obj.tool,
      args: obj.args && typeof obj.args === "object" ? (obj.args as Record<string, unknown>) : {},
      ok: obj.ok !== false,
      durationMs: typeof obj.durationMs === "number" ? obj.durationMs : 0,
      preview: typeof obj.preview === "string" ? obj.preview : "",
    };
  } catch {
    return null;
  }
}

function summarizeArgs(args: Record<string, unknown>): string {
  const entries = Object.entries(args).slice(0, 4);
  if (entries.length === 0) return "";
  return entries
    .map(([k, v]) => {
      let s: string;
      if (v === null || v === undefined) s = "—";
      else if (typeof v === "string") s = v;
      else if (typeof v === "number" || typeof v === "boolean") s = String(v);
      else {
        try {
          s = JSON.stringify(v);
        } catch {
          s = "[obj]";
        }
      }
      if (s.length > 60) s = s.slice(0, 60) + "…";
      return `${k}=${s}`;
    })
    .join(" ");
}

function ToolCallCard({ data }: { data: ToolCallPayload }) {
  const [expanded, setExpanded] = useState(false);
  const argSummary = summarizeArgs(data.args);
  const previewLines = data.preview ? data.preview.split("\n") : [];
  return (
    <div className="rounded-md border border-border/40 bg-muted/30 p-1.5 my-0.5 max-w-full">
      <button
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center gap-1.5 text-left group"
      >
        <div className="shrink-0 text-muted-foreground/50 group-hover:text-muted-foreground transition-colors">
          {expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        </div>
        <Wrench className="h-3 w-3 shrink-0 text-amber-300/80" />
        <span
          className="text-[10px] font-mono text-foreground/80 truncate flex-1"
          title={data.tool}
        >
          {data.tool}
          {argSummary && <span className="text-muted-foreground/70"> · {argSummary}</span>}
        </span>
        {data.durationMs > 0 && (
          <span className="shrink-0 text-[10px] font-mono text-muted-foreground/60">
            {data.durationMs}ms
          </span>
        )}
        <span
          className={cn(
            "shrink-0 text-[10px] font-mono uppercase tracking-wide",
            data.ok ? "text-green-400" : "text-red-400",
          )}
        >
          {data.ok ? "ok" : "err"}
        </span>
      </button>
      {expanded && (
        <div className="mt-1 space-y-1">
          {Object.keys(data.args).length > 0 && (
            <pre className="max-h-32 overflow-auto rounded bg-background/60 border border-border/40 p-1.5 text-[10px] font-mono leading-snug whitespace-pre-wrap break-all">
              {JSON.stringify(data.args, null, 2)}
            </pre>
          )}
          {previewLines.length > 0 && (
            <pre className="max-h-48 overflow-auto rounded bg-background/60 border border-border/40 p-1.5 text-[10px] font-mono leading-snug whitespace-pre-wrap break-all text-muted-foreground">
              {data.preview}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

function getStepIcon(eventType: string): React.ElementType {
  return STEP_ICON[eventType] ?? Code2;
}

function getStepColor(eventType: string): string {
  return STEP_COLOR[eventType] ?? "text-muted-foreground";
}

function groupEventsByNarration(events: StepEvent[]): StepGroup[] {
  const groups: StepGroup[] = [];
  let groupIndex = 0;

  for (const event of events) {
    if (event.eventType === "queued") continue;

    if (event.eventType === "narration") {
      if (groups.length > 0) {
        groups[groups.length - 1].isFinished = true;
      }
      groups.push({
        key: `group-${groupIndex++}`,
        narration: event.message,
        steps: [],
        isFinished: false,
      });
    } else {
      if (groups.length === 0) {
        groups.push({
          key: `group-${groupIndex++}`,
          narration: "",
          steps: [],
          isFinished: false,
        });
      }
      groups[groups.length - 1].steps.push(event);
    }
  }

  return groups;
}

function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds} second${seconds !== 1 ? "s" : ""}`;
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  if (secs === 0) return `${mins} min`;
  return `${mins} min ${secs} sec`;
}

function useWordReveal(text: string, active: boolean): string {
  const [revealed, setRevealed] = useState(0);
  const prevTextRef = useRef("");

  useEffect(() => {
    if (text !== prevTextRef.current) {
      prevTextRef.current = text;
      setRevealed(0);
    }
  }, [text]);

  useEffect(() => {
    if (!active || !text) return;
    const words = text.split(" ");
    if (revealed >= words.length) return;

    const delay = revealed === 0 ? 0 : 55;
    const t = setTimeout(() => {
      setRevealed((r) => Math.min(r + 1, words.length));
    }, delay);
    return () => clearTimeout(t);
  }, [active, text, revealed]);

  if (!text) return "";
  const words = text.split(" ");
  return words.slice(0, revealed).join(" ");
}

function NarrationText({
  text,
  isActive,
  isFinished,
}: {
  text: string;
  isActive: boolean;
  isFinished: boolean;
}) {
  const displayed = useWordReveal(text, isActive && !isFinished);

  if (!text) return null;

  return (
    <p
      className={cn(
        "text-xs leading-snug font-medium",
        isActive ? "text-foreground" : "text-muted-foreground/80",
      )}
    >
      {isActive && !isFinished ? displayed : text}
    </p>
  );
}

function IconStrip({
  steps,
  isGroupActive,
  isTerminal,
}: {
  steps: StepEvent[];
  isGroupActive: boolean;
  isTerminal: boolean;
}) {
  if (steps.length === 0) return null;

  return (
    <div className="flex flex-wrap items-center gap-1 mt-1.5">
      {steps.map((step, idx) => {
        const Icon = getStepIcon(step.eventType);
        const color = getStepColor(step.eventType);
        const isLast = idx === steps.length - 1;
        const isActive = isGroupActive && isLast && !isTerminal;

        return (
          <div
            key={step.id}
            title={step.message + (step.filePath ? ` — ${step.filePath}` : "")}
            className={cn(
              "flex items-center justify-center rounded p-0.5 transition-all duration-200",
              isActive ? "bg-primary/10" : "",
            )}
          >
            <Icon
              className={cn(
                "h-3 w-3 shrink-0",
                color,
                isActive && "animate-pulse",
                !isActive && "opacity-50",
              )}
            />
          </div>
        );
      })}
    </div>
  );
}

/**
 * Task #530 — parse the JSON preview payload emitted by the agentic builder
 * for creative tools (generate_image / generate_video / generate_audio /
 * remove_image_background). The backend emits two events per call: a short
 * "tool → path" line first, then a JSON payload with preview metadata
 * (path, mimeType, sizeKB, previewDataUri). Only the second one parses.
 */
type CreativePreview = {
  tool: string;
  path: string;
  mimeType: string;
  sizeKB: string;
  previewDataUri: string | null;
};
const CREATIVE_EVENTS = new Set([
  "generate_image",
  "generate_video",
  "generate_audio",
  "remove_image_background",
]);
function parseCreativeEvent(eventType: string, message: string): CreativePreview | null {
  if (!CREATIVE_EVENTS.has(eventType)) return null;
  if (!message || !message.startsWith("{")) return null;
  try {
    const obj = JSON.parse(message) as Partial<CreativePreview>;
    if (typeof obj.path !== "string" || typeof obj.mimeType !== "string") return null;
    return {
      tool: String(obj.tool ?? eventType),
      path: obj.path,
      mimeType: obj.mimeType,
      sizeKB: String(obj.sizeKB ?? ""),
      previewDataUri: typeof obj.previewDataUri === "string" ? obj.previewDataUri : null,
    };
  } catch {
    return null;
  }
}

/**
 * Task #733 — inline diff event emitted by write_file / apply_patch /
 * delete_file. Backend caps the diff body at 8KB and strips obvious secrets
 * before publishing; we just parse and render.
 */
type FileDiffPayload = {
  path: string;
  op: "write" | "patch" | "delete";
  added: number;
  removed: number;
  diff: string;
  truncated: boolean;
};
function parseFileDiff(eventType: string, message: string): FileDiffPayload | null {
  if (eventType !== "file_diff") return null;
  if (!message || !message.startsWith("{")) return null;
  try {
    const obj = JSON.parse(message) as Partial<FileDiffPayload>;
    if (typeof obj.path !== "string" || typeof obj.op !== "string") return null;
    return {
      path: obj.path,
      op: (obj.op as FileDiffPayload["op"]) ?? "write",
      added: typeof obj.added === "number" ? obj.added : 0,
      removed: typeof obj.removed === "number" ? obj.removed : 0,
      diff: typeof obj.diff === "string" ? obj.diff : "",
      truncated: obj.truncated === true,
    };
  } catch {
    return null;
  }
}

function FileDiffCard({ data }: { data: FileDiffPayload }) {
  const [expanded, setExpanded] = useState(false);
  const lines = data.diff ? data.diff.split("\n") : [];
  return (
    <div className="rounded-md border border-border/40 bg-muted/30 p-1.5 my-0.5 max-w-full">
      <button
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center gap-1.5 text-left group"
      >
        <div className="shrink-0 text-muted-foreground/50 group-hover:text-muted-foreground transition-colors">
          {expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        </div>
        <span
          className="text-[10px] font-mono text-foreground/80 truncate flex-1"
          title={data.path}
        >
          {data.path}
        </span>
        <span className="shrink-0 text-[10px] text-muted-foreground/70 uppercase tracking-wide">
          {data.op}
        </span>
        {data.added > 0 && (
          <span className="shrink-0 text-[10px] font-mono text-green-400">+{data.added}</span>
        )}
        {data.removed > 0 && (
          <span className="shrink-0 text-[10px] font-mono text-red-400">-{data.removed}</span>
        )}
      </button>
      {expanded && lines.length > 0 && (
        <pre className="mt-1 max-h-48 overflow-auto rounded bg-background/60 border border-border/40 p-1.5 text-[10px] font-mono leading-snug">
          {lines.map((l, i) => {
            const cls = l.startsWith("+ ")
              ? "text-green-400"
              : l.startsWith("- ")
                ? "text-red-400"
                : "text-muted-foreground";
            return (
              <div key={i} className={cn("whitespace-pre-wrap break-all", cls)}>
                {l || " "}
              </div>
            );
          })}
          {data.truncated && (
            <div className="text-muted-foreground/60 italic mt-1">
              (diff truncated to 8KB — open Tools & Files to see the full file)
            </div>
          )}
        </pre>
      )}
    </div>
  );
}

/**
 * Task #733 — `command_output` payload from run_command. Backend caps output
 * at 16KB and strips obvious secrets. Rendered as a collapsible terminal tile.
 */
type CommandOutputPayload = {
  runId: string;
  status: "running" | "chunk" | "final";
  seq: number;
  argv: string[];
  exitCode: number;
  durationMs: number;
  stdout: string;
  stderr: string;
  output: string;
  truncated: boolean;
  startedAt: number;
};
function parseCommandOutput(eventType: string, message: string): CommandOutputPayload | null {
  if (eventType !== "command_output") return null;
  if (!message || !message.startsWith("{")) return null;
  try {
    const obj = JSON.parse(message) as Partial<CommandOutputPayload>;
    if (!Array.isArray(obj.argv)) return null;
    const stdout = typeof obj.stdout === "string" ? obj.stdout : "";
    const stderr = typeof obj.stderr === "string" ? obj.stderr : "";
    const legacyOutput = typeof obj.output === "string" ? obj.output : "";
    const status: CommandOutputPayload["status"] =
      obj.status === "running" ? "running" : obj.status === "chunk" ? "chunk" : "final";
    return {
      runId: typeof obj.runId === "string" ? obj.runId : "",
      status,
      seq: typeof obj.seq === "number" ? obj.seq : 1,
      argv: obj.argv.map(String),
      exitCode: typeof obj.exitCode === "number" ? obj.exitCode : 0,
      durationMs: typeof obj.durationMs === "number" ? obj.durationMs : 0,
      stdout,
      stderr,
      // Legacy fallback for older snapshots that only stored joined `output`.
      output: stdout || stderr ? [stdout, stderr].filter(Boolean).join("\n") : legacyOutput,
      truncated: obj.truncated === true,
      startedAt: typeof obj.startedAt === "number" ? obj.startedAt : 0,
    };
  } catch {
    return null;
  }
}

/**
 * Collapse a sequence of command_output events down to one card per `runId`
 * by keeping the latest event for each command. This lets us render a
 * "running…" placeholder that gets replaced by the "final" exit-code card
 * once the command returns — without duplicating cards in the timeline.
 */
function dedupeCommandOutputs(steps: StepEvent[]): StepEvent[] {
  const out: StepEvent[] = [];
  const indexByRun = new Map<string, number>();
  const accumulatedByRun = new Map<string, { stdout: string; stderr: string }>();
  for (const s of steps) {
    if (s.eventType !== "command_output") {
      out.push(s);
      continue;
    }
    const parsed = parseCommandOutput(s.eventType, s.message);
    const runId = parsed?.runId ?? "";
    if (!parsed || !runId) {
      out.push(s);
      continue;
    }
    // Accumulate streamed `chunk` payloads so the rendered live card grows
    // as new tail content arrives. The `final` event carries the full
    // captured output and supersedes the accumulator.
    let acc = accumulatedByRun.get(runId);
    if (!acc) {
      acc = { stdout: "", stderr: "" };
      accumulatedByRun.set(runId, acc);
    }
    if (parsed.status === "chunk") {
      acc.stdout += parsed.stdout;
      acc.stderr += parsed.stderr;
    } else if (parsed.status === "final") {
      acc.stdout = parsed.stdout;
      acc.stderr = parsed.stderr;
    }
    // Rewrite the message to carry the accumulated stdout/stderr so the
    // downstream card sees a coherent snapshot regardless of which event
    // wins the dedupe slot.
    const enriched: StepEvent = {
      ...s,
      message: JSON.stringify({
        ...parsed,
        stdout: acc.stdout,
        stderr: acc.stderr,
        output: [acc.stdout, acc.stderr].filter(Boolean).join("\n"),
      }),
    };
    const prevIdx = indexByRun.get(runId);
    if (prevIdx === undefined) {
      indexByRun.set(runId, out.length);
      out.push(enriched);
    } else {
      // Replace the older event with the newer one, preserving the React
      // key so the card stays mounted across status transitions.
      out[prevIdx] = { ...enriched, id: out[prevIdx].id };
    }
  }
  return out;
}

function CommandOutputCard({
  data,
  projectId,
  taskId,
}: {
  data: CommandOutputPayload;
  projectId: number;
  taskId?: number;
}) {
  const isFinal = data.status === "final";
  const isStreaming = data.status === "running" || data.status === "chunk";
  const [expanded, setExpanded] = useState(false);
  const cmd = data.argv.join(" ").slice(0, 200);
  const ok = data.exitCode === 0;
  const hasStdout = data.stdout.length > 0;
  const hasStderr = isFinal && data.stderr.length > 0;
  // Task #733 (code-review pass): the "View full log" link now deep-links
  // to the Logs tab pre-filtered to the originating task (auto-expanded +
  // scrolled into view) and carries the run identifier so a future log
  // viewer can pinpoint the exact command. `cmd` is informational so the
  // user sees what they're filtering on if the task lookup misses.
  const params = new URLSearchParams({ tab: "logs" });
  if (taskId != null) params.set("logsTaskId", String(taskId));
  if (data.runId) params.set("runId", data.runId);
  if (cmd) params.set("cmd", cmd);
  const fullLogHref = `/projects/${projectId}?${params.toString()}`;
  return (
    <div className="rounded-md border border-border/40 bg-muted/30 p-1.5 my-0.5 max-w-full">
      <button
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center gap-1.5 text-left group"
      >
        <div className="shrink-0 text-muted-foreground/50 group-hover:text-muted-foreground transition-colors">
          {expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        </div>
        {isStreaming ? (
          <Loader2 className="h-3 w-3 shrink-0 text-cyan-400 animate-spin" />
        ) : (
          <TerminalSquare className="h-3 w-3 shrink-0 text-cyan-400" />
        )}
        <span className="text-[10px] font-mono text-foreground/80 truncate flex-1" title={cmd}>
          {cmd}
        </span>
        {isStreaming ? (
          <span className="shrink-0 text-[10px] font-mono text-cyan-400">
            {data.status === "chunk" ? "streaming…" : "running…"}
          </span>
        ) : (
          <>
            <span
              className={cn(
                "shrink-0 text-[10px] font-mono",
                ok ? "text-green-400" : "text-red-400",
              )}
            >
              exit={data.exitCode}
            </span>
            <span className="shrink-0 text-[10px] text-muted-foreground/60">
              {data.durationMs}ms
            </span>
          </>
        )}
      </button>
      {expanded && (
        <div className="mt-1 space-y-1">
          {data.status === "running" && !hasStdout ? (
            <div className="rounded bg-black/60 border border-border/40 p-1.5 text-[10px] font-mono text-cyan-300/70 italic">
              Waiting for command to finish…
            </div>
          ) : (
            <>
              {hasStdout && (
                <pre className="max-h-48 overflow-auto rounded bg-black/60 border border-border/40 p-1.5 text-[10px] font-mono leading-snug text-green-300 whitespace-pre-wrap break-all">
                  {data.stdout}
                  {data.status === "chunk" && (
                    <span className="text-cyan-300/60 animate-pulse">▌</span>
                  )}
                </pre>
              )}
              {hasStderr && (
                <pre className="max-h-48 overflow-auto rounded bg-black/60 border border-destructive/30 p-1.5 text-[10px] font-mono leading-snug text-red-300 whitespace-pre-wrap break-all">
                  {data.stderr}
                </pre>
              )}
              {isFinal && !hasStdout && !hasStderr && (
                <div className="rounded bg-black/60 border border-border/40 p-1.5 text-[10px] font-mono text-muted-foreground/60 italic">
                  (no output)
                </div>
              )}
            </>
          )}
          {data.truncated && (
            <div className="flex items-center gap-1 text-[10px] text-muted-foreground/70 italic">
              <span>Output truncated to 16KB.</span>
              <a
                href={fullLogHref}
                className="inline-flex items-center gap-0.5 not-italic text-primary/80 hover:text-primary transition-colors"
                title="Open the Logs tab to see the full command stream"
              >
                View full log
                <ExternalLink className="h-2.5 w-2.5" />
              </a>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ThinkingRow({ text, isActive }: { text: string; isActive: boolean }) {
  // Task #733 (code-review pass): use the same typewriter reveal as the
  // narration line so the thinking row feels alive when the agent is mid-step
  // rather than popping in fully-formed.
  const displayed = useWordReveal(text, isActive);
  const shown = isActive ? displayed : text;
  return (
    <div className="flex items-start gap-1.5 py-0.5 italic text-muted-foreground/70">
      <BrainCircuit className="h-3 w-3 shrink-0 mt-px text-violet-300/70" />
      <span className="text-[11px] leading-tight">{shown}</span>
    </div>
  );
}

const HIDE_THINKING_KEY = "mustaflow_hide_thinking";
function useHideThinking(): [boolean, (v: boolean) => void] {
  const [hide, setHide] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return window.localStorage.getItem(HIDE_THINKING_KEY) === "1";
  });
  const update = (v: boolean) => {
    setHide(v);
    try {
      window.localStorage.setItem(HIDE_THINKING_KEY, v ? "1" : "0");
    } catch {
      // ignore
    }
  };
  return [hide, update];
}

function CreativePreviewCard({ data }: { data: CreativePreview }) {
  const isImage = data.mimeType.startsWith("image/");
  const isAudio = data.mimeType.startsWith("audio/");
  const isVideo = data.mimeType.startsWith("video/");
  return (
    <div className="flex items-start gap-2 rounded-md border border-border/40 bg-muted/30 p-1.5 my-0.5 max-w-full">
      {isImage && data.previewDataUri ? (
        <img
          src={data.previewDataUri}
          alt={data.path}
          className="h-10 w-10 shrink-0 rounded object-cover border border-border/40"
        />
      ) : (
        <div className="h-10 w-10 shrink-0 rounded bg-background/60 border border-border/40 flex items-center justify-center">
          <Sparkles className="h-4 w-4 text-violet-400" />
        </div>
      )}
      <div className="min-w-0 flex-1">
        <span className="text-[11px] text-foreground/90 leading-tight block truncate font-medium">
          {data.tool.replace(/_/g, " ")}
        </span>
        <span className="text-[10px] font-mono text-muted-foreground/70 truncate block">
          {data.path}
        </span>
        <span className="text-[10px] text-muted-foreground/50 block">
          {data.mimeType}
          {data.sizeKB ? ` • ${data.sizeKB} KB` : ""}
        </span>
        {isAudio && data.previewDataUri && (
          <audio src={data.previewDataUri} controls className="w-full h-6 mt-1" />
        )}
        {isVideo && data.previewDataUri && (
          <video
            src={data.previewDataUri}
            controls
            className="w-full max-h-32 mt-1 rounded"
            muted
          />
        )}
      </div>
    </div>
  );
}

function FinishedGroupRow({
  group,
  hideThinking,
  projectId,
  taskId,
}: {
  group: StepGroup;
  hideThinking: boolean;
  projectId: number;
  taskId?: number;
}) {
  const [expanded, setExpanded] = useState(false);
  const filtered = hideThinking
    ? group.steps.filter((s) => s.eventType !== "thinking")
    : group.steps;
  const visibleSteps = dedupeCommandOutputs(filtered);

  return (
    <div className="space-y-1">
      <button
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-start gap-2 group text-left"
      >
        <div className="shrink-0 mt-0.5 text-muted-foreground/40 group-hover:text-muted-foreground transition-colors">
          {expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        </div>
        <div className="flex-1 min-w-0">
          {group.narration && (
            <p className="text-[11px] text-muted-foreground/70 leading-snug truncate">
              {group.narration}
            </p>
          )}
          <div className="flex items-center gap-2 mt-0.5">
            <div className="flex items-center gap-0.5">
              {visibleSteps.slice(0, 10).map((step) => {
                const Icon = getStepIcon(step.eventType);
                const color = getStepColor(step.eventType);
                return <Icon key={step.id} className={cn("h-2.5 w-2.5", color, "opacity-40")} />;
              })}
            </div>
            <span className="text-[10px] text-muted-foreground/50">
              {visibleSteps.length} action{visibleSteps.length !== 1 ? "s" : ""}
            </span>
          </div>
        </div>
      </button>

      {expanded && (
        <div className="ml-5 space-y-0.5 border-l border-border/40 pl-2">
          {visibleSteps.map((step) => {
            const Icon = getStepIcon(step.eventType);
            const color = getStepColor(step.eventType);
            const creative = parseCreativeEvent(step.eventType, step.message);
            const diff = parseFileDiff(step.eventType, step.message);
            const cmd = parseCommandOutput(step.eventType, step.message);
            const tool = parseToolCall(step.eventType, step.message);
            if (step.eventType === "thinking") {
              return <ThinkingRow key={step.id} text={step.message} isActive={false} />;
            }
            return (
              <div key={step.id} className="flex items-start gap-1.5 py-0.5">
                <Icon className={cn("h-3 w-3 shrink-0 mt-px", color, "opacity-60")} />
                <div className="min-w-0 flex-1">
                  {creative ? (
                    <CreativePreviewCard data={creative} />
                  ) : diff ? (
                    <FileDiffCard data={diff} />
                  ) : cmd ? (
                    <CommandOutputCard data={cmd} projectId={projectId} taskId={taskId} />
                  ) : tool ? (
                    <ToolCallCard data={tool} />
                  ) : (
                    <>
                      <span className="text-[11px] text-muted-foreground leading-tight block truncate">
                        {step.message}
                      </span>
                      {step.filePath && (
                        <span className="text-[10px] font-mono text-muted-foreground/50 truncate block">
                          {step.filePath}
                        </span>
                      )}
                    </>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function ActiveGroupRow({
  group,
  isTerminal,
  hideThinking,
  projectId,
  taskId,
}: {
  group: StepGroup;
  isTerminal: boolean;
  hideThinking: boolean;
  projectId: number;
  taskId?: number;
}) {
  const filtered = hideThinking
    ? group.steps.filter((s) => s.eventType !== "thinking")
    : group.steps;
  const visibleSteps = dedupeCommandOutputs(filtered);
  const lastStep = visibleSteps[visibleSteps.length - 1];
  // Task #733: when the current step is a structured payload (file_diff /
  // command_output) the JSON blob is useless as a status string, so fall back
  // to a friendlier label. For thinking events, surface the trimmed text.
  const fallbackLabel = (() => {
    if (!lastStep) return isTerminal ? "Done" : "Working…";
    const diff = parseFileDiff(lastStep.eventType, lastStep.message);
    if (diff) return `${diff.op} ${diff.path}`;
    const cmd = parseCommandOutput(lastStep.eventType, lastStep.message);
    if (cmd) return `${cmd.argv.join(" ").slice(0, 80)} (exit=${cmd.exitCode})`;
    const tool = parseToolCall(lastStep.eventType, lastStep.message);
    if (tool) return `${tool.tool}${tool.ok ? "" : " (failed)"}`;
    return lastStep.message;
  })();

  // Render the latest structured step inline so live diffs / output appear
  // without waiting for the group to finish.
  const lastDiff = lastStep ? parseFileDiff(lastStep.eventType, lastStep.message) : null;
  const lastCmd = lastStep ? parseCommandOutput(lastStep.eventType, lastStep.message) : null;
  const lastTool = lastStep ? parseToolCall(lastStep.eventType, lastStep.message) : null;
  const lastThinking = lastStep?.eventType === "thinking" ? lastStep.message : null;

  return (
    <div className="space-y-1">
      <NarrationText text={group.narration} isActive={true} isFinished={isTerminal} />
      <IconStrip steps={visibleSteps} isGroupActive={true} isTerminal={isTerminal} />
      {lastThinking && <ThinkingRow text={lastThinking} isActive={!isTerminal} />}
      {lastDiff && <FileDiffCard data={lastDiff} />}
      {lastCmd && <CommandOutputCard data={lastCmd} projectId={projectId} taskId={taskId} />}
      {lastTool && <ToolCallCard data={lastTool} />}
      {visibleSteps.length > 0 && !lastDiff && !lastCmd && !lastTool && !lastThinking && (
        <p
          className={cn(
            "text-[10px] truncate leading-tight",
            isTerminal ? "text-muted-foreground/50" : "text-muted-foreground",
          )}
        >
          {fallbackLabel}
        </p>
      )}
    </div>
  );
}

function BuildTimingRow({
  elapsedSeconds,
  isFailed,
  groupsExpanded,
  onToggle,
}: {
  elapsedSeconds: number;
  isFailed: boolean;
  groupsExpanded: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      onClick={onToggle}
      className={cn(
        "w-full flex items-center gap-2 group text-left py-1 rounded transition-colors",
        isFailed ? "hover:bg-destructive/5" : "hover:bg-background/30",
      )}
    >
      <div className="shrink-0 text-muted-foreground/50 group-hover:text-muted-foreground transition-colors">
        {groupsExpanded ? (
          <ChevronDown className="h-3 w-3" />
        ) : (
          <ChevronRight className="h-3 w-3" />
        )}
      </div>
      <Timer
        className={cn(
          "h-3 w-3 shrink-0",
          isFailed ? "text-destructive/70" : "text-muted-foreground/60",
        )}
      />
      <span
        className={cn(
          "text-[11px] font-medium",
          isFailed ? "text-destructive/80" : "text-muted-foreground/70",
        )}
      >
        {isFailed ? "Failed after" : "Worked for"} {formatElapsed(elapsedSeconds)}
      </span>
    </button>
  );
}

function CheckpointRow({
  projectId,
  versionId,
  versionLabel,
  onViewHistory,
}: {
  projectId: number;
  versionId: number;
  versionLabel: string;
  onViewHistory?: () => void;
}) {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(versionLabel);
  const [savedLabel, setSavedLabel] = useState(versionLabel);
  const inputRef = useRef<HTMLInputElement>(null);
  const patchVersion = usePatchVersion();

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editing]);

  const save = () => {
    const trimmed = draft.trim();
    if (!trimmed || trimmed === savedLabel) {
      setDraft(savedLabel);
      setEditing(false);
      return;
    }
    patchVersion.mutate(
      { id: projectId, versionId, data: { label: trimmed } },
      {
        onSuccess: () => {
          setSavedLabel(trimmed);
          setDraft(trimmed);
          void queryClient.invalidateQueries({
            queryKey: getListVersionsQueryKey(projectId),
          });
        },
        onError: () => {
          setDraft(savedLabel);
        },
        onSettled: () => {
          setEditing(false);
        },
      },
    );
  };

  const cancel = () => {
    setDraft(savedLabel);
    setEditing(false);
  };

  return (
    <div className="flex items-center gap-2 py-1 px-0.5 animate-in fade-in slide-in-from-bottom-1 duration-300">
      <Bookmark className="h-3 w-3 shrink-0 text-secondary/70" />
      <span className="text-[10px] text-muted-foreground/60 shrink-0">Checkpoint</span>
      {editing ? (
        <div className="flex items-center gap-1 flex-1 min-w-0">
          <input
            ref={inputRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") save();
              if (e.key === "Escape") cancel();
            }}
            onBlur={save}
            className="flex-1 min-w-0 bg-background border border-border rounded px-1.5 py-0.5 text-[11px] text-foreground outline-none focus:border-primary"
          />
          <button
            onMouseDown={(e) => {
              e.preventDefault();
              save();
            }}
            className="shrink-0 text-green-400 hover:text-green-300 transition-colors"
          >
            <Check className="h-3 w-3" />
          </button>
          <button
            onMouseDown={(e) => {
              e.preventDefault();
              cancel();
            }}
            className="shrink-0 text-muted-foreground/50 hover:text-muted-foreground transition-colors"
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      ) : (
        <div className="flex items-center gap-1.5 flex-1 min-w-0">
          <span className="text-[11px] text-foreground/80 truncate" title={savedLabel}>
            {patchVersion.isPending ? draft : savedLabel}
          </span>
          <button
            onClick={() => setEditing(true)}
            className="shrink-0 text-muted-foreground/30 hover:text-muted-foreground/70 transition-colors"
            title="Rename checkpoint"
          >
            <Pencil className="h-2.5 w-2.5" />
          </button>
          {onViewHistory && (
            <button
              onClick={onViewHistory}
              className="shrink-0 flex items-center gap-0.5 text-[10px] text-primary/60 hover:text-primary transition-colors ml-auto"
              title="View in history"
            >
              <ExternalLink className="h-2.5 w-2.5" />
              <span>History</span>
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function KnowledgeAppliedRow({
  entries,
}: {
  entries: Array<{ id: number; title: string; category: string }>;
}) {
  const [expanded, setExpanded] = useState(false);
  const count = entries.length;
  const label = `${count} ${count === 1 ? "memory" : "memories"} applied`;
  const ids = entries.map((e) => e.id).join(",");

  return (
    <div className="space-y-1 animate-in fade-in slide-in-from-bottom-1 duration-300">
      <div className="flex items-center gap-2 py-0.5 rounded">
        <button
          onClick={() => setExpanded((v) => !v)}
          className="flex items-center gap-2 flex-1 min-w-0 group text-left hover:bg-background/30 rounded px-1 -mx-1 py-0.5 transition-colors"
          title="See which saved preferences the agent used"
        >
          <div className="shrink-0 text-muted-foreground/50 group-hover:text-muted-foreground transition-colors">
            {expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
          </div>
          <BrainCircuit className="h-3 w-3 shrink-0 text-violet-400" />
          <span className="text-[11px] font-medium text-foreground/85 truncate">{label}</span>
        </button>
        <a
          href={`/knowledge?ids=${ids}`}
          target="_blank"
          rel="noopener noreferrer"
          className="shrink-0 flex items-center gap-0.5 text-[10px] text-primary/60 hover:text-primary transition-colors"
          title="Open in Knowledge Vault"
        >
          <ExternalLink className="h-2.5 w-2.5" />
          <span>Vault</span>
        </a>
      </div>

      {expanded && (
        <div className="ml-5 space-y-0.5 border-l border-border/40 pl-2">
          {entries.map((entry) => (
            <a
              key={entry.id}
              href={`/knowledge?ids=${entry.id}`}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1.5 py-0.5 group hover:bg-background/40 rounded px-1 -mx-1 transition-colors"
              title={entry.title}
            >
              <span className="text-[9px] font-medium text-muted-foreground bg-muted border border-border px-1.5 py-0.5 rounded uppercase tracking-wide shrink-0">
                {entry.category}
              </span>
              <span className="text-[11px] text-foreground/80 truncate flex-1 group-hover:text-foreground transition-colors">
                {entry.title}
              </span>
              <ExternalLink className="h-2.5 w-2.5 shrink-0 text-muted-foreground/30 group-hover:text-primary transition-colors" />
            </a>
          ))}
        </div>
      )}
    </div>
  );
}

interface Props {
  projectId: number;
  taskId: number;
  startedAt?: Date | null;
  onDismiss: () => void;
  onViewHistory?: (versionId: number) => void;
}

export function AgentThinkingBubble({
  projectId,
  taskId,
  startedAt,
  onDismiss,
  onViewHistory,
}: Props) {
  const bubbleRef = useRef<HTMLDivElement>(null);
  const mountTimeRef = useRef(Date.now());
  const [elapsedSeconds, setElapsedSeconds] = useState<number | null>(null);
  const [groupsExpanded, setGroupsExpanded] = useState(true);
  const [cancelling, setCancelling] = useState(false);
  const [forceStarting, setForceStarting] = useState(false);
  const [hideThinking, setHideThinking] = useHideThinking();
  const cancelTask = useCancelTask();
  const forceStartTask = useForceStartTask();

  const events = useTaskEventStream(projectId, taskId);

  const lastEvent = events[events.length - 1];
  const isTerminal = lastEvent ? TERMINAL_STATUSES.has(lastEvent.eventType as string) : false;
  const isDone = lastEvent?.eventType === "completed";
  const isFailed = lastEvent?.eventType === "failed";
  const isCancelled = lastEvent?.eventType === "cancelled";
  // True when the task is sitting in the queue (only event so far is "queued").
  // Once the job starts running it emits additional events and this flips false.
  const isQueued = events.length > 0 && events.every((e) => e.eventType === "queued");

  const handleCancel = () => {
    if (cancelling || isTerminal) return;
    setCancelling(true);
    cancelTask.mutate(
      { id: projectId, taskId },
      {
        onSettled: () => {
          setCancelling(false);
        },
      },
    );
  };

  const handleForceStart = () => {
    if (forceStarting) return;
    setForceStarting(true);
    forceStartTask.mutate(
      { id: projectId, taskId },
      {
        onSettled: () => {
          setForceStarting(false);
        },
      },
    );
  };

  const { data: tasks } = useListTasks(projectId, {
    query: {
      queryKey: getListTasksQueryKey(projectId),
      // Always poll while waiting so we can detect a server-side failure
      // (e.g. runJob crashed) even when no events were ever emitted.
      enabled: true,
      refetchInterval: isTerminal ? false : 3000,
      staleTime: 0,
    },
  });

  const completedTask = tasks?.find((t) => t.id === taskId);
  // If we have no events yet but the task in DB is already failed/cancelled/done,
  // treat the bubble as terminal so it doesn't sit at "Starting up…" forever.
  const taskStatus = completedTask?.status as string | undefined;
  const taskTerminalFromDb =
    taskStatus === "failed" || taskStatus === "cancelled" || taskStatus === "completed";
  const stalled = events.length === 0 && taskTerminalFromDb;

  // Auto-dismiss if the bubble is stuck at "Starting up…" with no events
  // and no DB status for too long (90s) — the worker probably died.
  useEffect(() => {
    if (events.length > 0 || taskTerminalFromDb) return;
    const t = setTimeout(onDismiss, 90_000);
    return () => clearTimeout(t);
  }, [events.length, taskTerminalFromDb, onDismiss]);

  useEffect(() => {
    if (!stalled) return;
    const t = setTimeout(onDismiss, 1500);
    return () => clearTimeout(t);
  }, [stalled, onDismiss]);
  const completedReport = completedTask?.report as
    | {
        versionId?: number | null;
        knowledgeApplied?: Array<{ id: number; title: string; category: string }>;
      }
    | null
    | undefined;
  const versionId = completedReport?.versionId ?? null;
  const knowledgeApplied = completedReport?.knowledgeApplied ?? [];

  const { data: versions } = useListVersions(projectId, {
    query: {
      queryKey: getListVersionsQueryKey(projectId),
      enabled: isTerminal && isDone && !!versionId,
      staleTime: 0,
    },
  });

  const versionLabel =
    versionId != null ? (versions?.find((v) => v.id === versionId)?.label ?? null) : null;

  useEffect(() => {
    if (!isTerminal) return;
    // Prefer the authoritative server-calculated value (from startedAt → completedAt).
    // Fall back to client-side wall-clock if the task isn't in the list yet.
    const serverElapsed = completedTask?.elapsedSeconds ?? null;
    if (serverElapsed != null) {
      setElapsedSeconds(Math.max(1, serverElapsed));
    } else {
      const origin = startedAt ?? new Date(mountTimeRef.current);
      setElapsedSeconds(Math.max(1, Math.round((Date.now() - origin.getTime()) / 1000)));
    }
  }, [isTerminal, startedAt, completedTask?.elapsedSeconds]);

  const groups = groupEventsByNarration(events as StepEvent[]);
  const finishedGroups = groups.slice(0, -1);
  const activeGroup = groups[groups.length - 1] ?? null;

  useEffect(() => {
    if (!isTerminal) return;
    const delay = isCancelled ? 1500 : 2500;
    const t = setTimeout(onDismiss, delay);
    return () => clearTimeout(t);
  }, [isTerminal, isCancelled, onDismiss]);

  useEffect(() => {
    if (bubbleRef.current) {
      bubbleRef.current.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  }, [events.length]);

  if (events.length === 0) {
    if (stalled) {
      return (
        <div className="flex justify-start">
          <div className="bg-destructive/10 border border-destructive/30 rounded-xl rounded-bl-sm px-3 py-2 text-xs flex items-center gap-2 max-w-[92%]">
            <span className="text-muted-foreground">
              The task didn’t start. Please try sending again.
            </span>
          </div>
        </div>
      );
    }
    return (
      <div className="flex justify-start">
        <div className="bg-muted border border-border rounded-xl rounded-bl-sm px-3 py-2 text-xs flex items-center gap-2 max-w-[92%]">
          <Loader2 className="h-3 w-3 animate-spin text-primary shrink-0" />
          <span className="text-muted-foreground">Starting up…</span>
        </div>
      </div>
    );
  }

  return (
    <div ref={bubbleRef} className="flex justify-start">
      <div
        className={cn(
          "max-w-[92%] rounded-xl rounded-bl-sm border text-xs overflow-hidden transition-colors duration-300",
          isFailed ? "bg-destructive/10 border-destructive/30" : "bg-muted border-border",
        )}
      >
        {/* Header pulse */}
        <div className="flex items-center gap-2 px-3 pt-2.5 pb-1.5">
          {isTerminal ? (
            isDone ? (
              <CheckCircle2 className="h-3 w-3 text-green-400 shrink-0" />
            ) : isCancelled ? (
              <Square className="h-3 w-3 text-muted-foreground shrink-0" />
            ) : (
              <XCircle className="h-3 w-3 text-destructive shrink-0" />
            )
          ) : isQueued ? (
            <Clock className="h-3 w-3 text-muted-foreground shrink-0" />
          ) : (
            <span className="relative flex h-2 w-2 shrink-0">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-primary opacity-75" />
              <span className="relative inline-flex rounded-full h-2 w-2 bg-primary" />
            </span>
          )}
          <span
            className={cn(
              "text-[11px] font-semibold flex-1",
              isDone
                ? "text-green-400"
                : isCancelled
                  ? "text-muted-foreground"
                  : isFailed
                    ? "text-destructive"
                    : isQueued
                      ? "text-muted-foreground"
                      : "text-primary",
            )}
          >
            {isDone
              ? "Build complete"
              : isCancelled
                ? "Cancelled"
                : isFailed
                  ? "Build failed"
                  : cancelling
                    ? "Cancelling…"
                    : isQueued
                      ? "Queued"
                      : "Building"}
          </span>
          {!isQueued && (
            <button
              onClick={() => setHideThinking(!hideThinking)}
              title={hideThinking ? "Show agent thinking" : "Hide agent thinking"}
              className="flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded border border-border text-muted-foreground hover:text-foreground transition-colors shrink-0"
            >
              {hideThinking ? <EyeOff className="h-2.5 w-2.5" /> : <Eye className="h-2.5 w-2.5" />}
            </button>
          )}
          {isQueued && (
            <button
              onClick={handleForceStart}
              disabled={forceStarting}
              title="Cancel the current build and start this task now"
              className={cn(
                "flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded border transition-colors shrink-0",
                forceStarting
                  ? "text-muted-foreground border-border cursor-not-allowed opacity-50"
                  : "text-muted-foreground border-border hover:text-primary hover:border-primary/50",
              )}
            >
              {forceStarting ? (
                <Loader2 className="h-2.5 w-2.5 animate-spin" />
              ) : (
                <Timer className="h-2.5 w-2.5" />
              )}
              Run now
            </button>
          )}
          {!isTerminal && !isQueued && (
            <button
              onClick={handleCancel}
              disabled={cancelling}
              title="Cancel build"
              data-testid="cancel-build-btn"
              className={cn(
                "flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded border transition-colors shrink-0",
                cancelling
                  ? "text-muted-foreground border-border cursor-not-allowed opacity-50"
                  : "text-muted-foreground border-border hover:text-destructive hover:border-destructive/50",
              )}
            >
              {cancelling ? (
                <Loader2 className="h-2.5 w-2.5 animate-spin" />
              ) : (
                <Square className="h-2.5 w-2.5" />
              )}
              Cancel
            </button>
          )}
        </div>

        {/* Build timing row (shown when terminal) */}
        {isTerminal && elapsedSeconds !== null && (
          <div className="px-3 pb-1">
            <BuildTimingRow
              elapsedSeconds={elapsedSeconds}
              isFailed={isFailed}
              groupsExpanded={groupsExpanded}
              onToggle={() => setGroupsExpanded((v) => !v)}
            />
          </div>
        )}

        {/* Groups (collapsible via timing row toggle) */}
        {groupsExpanded && (
          <div className="px-3 pb-2.5 space-y-2.5">
            {finishedGroups.map((group) => (
              <FinishedGroupRow
                key={group.key}
                group={group}
                hideThinking={hideThinking}
                projectId={projectId}
                taskId={taskId}
              />
            ))}

            {activeGroup && (
              <ActiveGroupRow
                key={activeGroup.key}
                group={activeGroup}
                isTerminal={isTerminal}
                hideThinking={hideThinking}
                projectId={projectId}
                taskId={taskId}
              />
            )}

            {groups.length === 0 && !isTerminal && (
              <div className="flex items-center gap-2 text-muted-foreground">
                {isQueued ? (
                  <Clock className="h-2.5 w-2.5 shrink-0" />
                ) : (
                  <div className="animate-spin h-2.5 w-2.5 border border-primary border-t-transparent rounded-full shrink-0" />
                )}
                <span className="text-[11px]">
                  {isQueued
                    ? "Waiting for the current build to finish — will start automatically…"
                    : "Waiting for first event…"}
                </span>
              </div>
            )}
          </div>
        )}

        {/* Memory indicator (Task #664) — surface user memories that were applied */}
        {isTerminal && isDone && knowledgeApplied.length > 0 && (
          <div className="px-3 pb-2 border-t border-border/40 pt-1.5">
            <KnowledgeAppliedRow entries={knowledgeApplied} />
          </div>
        )}

        {/* Checkpoint row (shown on success when versionId is known) */}
        {isTerminal && isDone && versionId != null && versionLabel != null && (
          <div className="px-3 pb-2.5 border-t border-border/40 pt-1.5">
            <CheckpointRow
              projectId={projectId}
              versionId={versionId}
              versionLabel={versionLabel}
              onViewHistory={versionId != null ? () => onViewHistory?.(versionId) : undefined}
            />
          </div>
        )}
      </div>
    </div>
  );
}
