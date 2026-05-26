/**
 * ToolCallCard — inline collapsible card for a single tool-call event in the
 * Zero agent chat thread.  Mirrors the AgentThinkingBubble step rendering but
 * is designed for *persisted* (post-completion) display alongside the message
 * history rather than the live SSE stream.
 *
 * The card shows:
 *   • Tool icon + human-readable label
 *   • Input summary (file path, shell command, URL, etc.)
 *   • Collapsible output preview:
 *       - command_output: "$  <command>" header + truncated stdout
 *       - file_diff: +N / -N stats + optional inline diff body
 *       - everything else: raw text, truncated
 */
import { useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  FileText,
  FilePen,
  TerminalSquare,
  Globe,
  Search,
  Wrench,
  Eye,
  Camera,
  Sparkles,
  CheckCircle2,
  AlertCircle,
  Loader2,
} from "lucide-react";
import { cn } from "@/lib/utils";

export type ToolCallEventType =
  | "read_file"
  | "write_file"
  | "apply_patch"
  | "list_directory"
  | "shell_command"
  | "command_output"
  | "web_search"
  | "web_fetch"
  | "take_screenshot"
  | "generate_image"
  | "file_diff"
  | "tool_call"
  | "thinking"
  | string;

export type ToolCallEvent = {
  id: number;
  eventType: ToolCallEventType;
  message: string;
  /** ISO timestamp */
  createdAt?: string;
};

const EVENT_ICON: Record<string, React.ElementType> = {
  read_file: Eye,
  write_file: FilePen,
  apply_patch: FilePen,
  list_directory: FileText,
  shell_command: TerminalSquare,
  command_output: TerminalSquare,
  web_search: Search,
  web_fetch: Globe,
  take_screenshot: Camera,
  generate_image: Sparkles,
  file_diff: FilePen,
  tool_call: Wrench,
  thinking: Sparkles,
};

const EVENT_LABEL: Record<string, string> = {
  read_file: "Reading file",
  write_file: "Writing file",
  apply_patch: "Applying patch",
  list_directory: "Listing directory",
  shell_command: "Running command",
  command_output: "Command output",
  web_search: "Web search",
  web_fetch: "Fetching URL",
  take_screenshot: "Taking screenshot",
  generate_image: "Generating image",
  file_diff: "File diff",
  tool_call: "Tool call",
  thinking: "Thinking",
};

const EVENT_COLOR: Record<string, string> = {
  read_file: "text-blue-400 bg-blue-500/8 border-blue-500/20",
  write_file: "text-yellow-400 bg-yellow-500/8 border-yellow-500/20",
  apply_patch: "text-yellow-400 bg-yellow-500/8 border-yellow-500/20",
  list_directory: "text-sky-400 bg-sky-500/8 border-sky-500/20",
  shell_command: "text-cyan-400 bg-cyan-500/8 border-cyan-500/20",
  command_output: "text-cyan-400 bg-cyan-500/8 border-cyan-500/20",
  web_search: "text-violet-400 bg-violet-500/8 border-violet-500/20",
  web_fetch: "text-violet-400 bg-violet-500/8 border-violet-500/20",
  take_screenshot: "text-indigo-400 bg-indigo-500/8 border-indigo-500/20",
  generate_image: "text-pink-400 bg-pink-500/8 border-pink-500/20",
  file_diff: "text-amber-400 bg-amber-500/8 border-amber-500/20",
  tool_call: "text-amber-400 bg-amber-500/8 border-amber-500/20",
  thinking: "text-violet-300 bg-violet-500/8 border-violet-500/20",
};

// ─── Payload parsers ────────────────────────────────────────────────────────

/** Tries to parse a JSON blob; returns undefined on failure. */
function tryJson<T>(s: string): T | undefined {
  if (!s.startsWith("{") && !s.startsWith("[")) return undefined;
  try {
    return JSON.parse(s) as T;
  } catch {
    return undefined;
  }
}

type FileDiffPayload = { path?: string; added?: number; removed?: number; diff?: string };

function parseFileDiff(
  msg: string,
): { path: string; added: number; removed: number; diff?: string } | null {
  // JSON payload: { path, added, removed, diff? }
  const obj = tryJson<FileDiffPayload>(msg);
  if (obj?.path) {
    return {
      path: obj.path,
      added: obj.added ?? 0,
      removed: obj.removed ?? 0,
      diff: obj.diff,
    };
  }
  // Text format: "path/to/file.ts +12 -3"
  const m = /^(.+?)\s+\+(\d+)\s+-(\d+)/.exec(msg.trim());
  if (m) return { path: m[1]!, added: Number(m[2]), removed: Number(m[3]) };
  return null;
}

type CommandOutputPayload = {
  command?: string;
  stdout?: string;
  stderr?: string;
  exitCode?: number;
};

function parseCommandOutput(msg: string): CommandOutputPayload | null {
  const obj = tryJson<CommandOutputPayload>(msg);
  if (obj && (obj.command !== undefined || obj.stdout !== undefined)) return obj;
  return null;
}

function truncate(s: string, n = 220): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

// ─── Diff line coloring ─────────────────────────────────────────────────────

function DiffBody({ diff }: { diff: string }) {
  return (
    <pre className="mt-1 text-[9px] font-mono whitespace-pre-wrap max-h-40 overflow-y-auto leading-relaxed">
      {diff
        .split("\n")
        .slice(0, 80)
        .map((line, i) => (
          <span
            key={i}
            className={
              line.startsWith("+") && !line.startsWith("+++")
                ? "text-green-400 block"
                : line.startsWith("-") && !line.startsWith("---")
                  ? "text-red-400 block"
                  : line.startsWith("@@")
                    ? "text-sky-400 block"
                    : "text-muted-foreground/60 block"
            }
          >
            {line}
          </span>
        ))}
    </pre>
  );
}

// ─── Main card ───────────────────────────────────────────────────────────────

/** A single collapsible tool-call event row */
export function ToolCallCard({
  event,
  isLive = false,
}: {
  event: ToolCallEvent;
  isLive?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);

  const Icon = EVENT_ICON[event.eventType] ?? Wrench;
  const label = EVENT_LABEL[event.eventType] ?? event.eventType.replace(/_/g, " ");
  const colorClass =
    EVENT_COLOR[event.eventType] ?? "text-muted-foreground bg-muted/40 border-border";

  // Parse structured payloads
  const diff =
    event.eventType === "file_diff" || event.eventType === "apply_patch"
      ? parseFileDiff(event.message)
      : null;
  const cmdOut =
    event.eventType === "command_output" || event.eventType === "shell_command"
      ? parseCommandOutput(event.message)
      : null;

  // Inline summary shown in the collapsed header
  const inlineSummary = (() => {
    if (diff) {
      return (
        <span className="flex items-center gap-1 ml-1 font-mono opacity-80 truncate">
          <span className="text-foreground/70 truncate">{diff.path}</span>
          {diff.added > 0 && <span className="text-green-400">+{diff.added}</span>}
          {diff.removed > 0 && <span className="text-red-400">-{diff.removed}</span>}
        </span>
      );
    }
    if (cmdOut?.command) {
      return (
        <span className="font-mono opacity-70 truncate flex-1">
          $ {truncate(cmdOut.command, 55)}
        </span>
      );
    }
    return (
      <span className="font-mono opacity-70 truncate flex-1">{truncate(event.message, 60)}</span>
    );
  })();

  // Whether there is expandable detail
  const hasDetail =
    diff?.diff || (cmdOut && (cmdOut.stdout || cmdOut.stderr)) || event.message.length > 60;

  return (
    <div className={cn("rounded-lg border text-[10px] overflow-hidden", colorClass)}>
      <button
        onClick={() => hasDetail && setExpanded((v) => !v)}
        className={cn(
          "w-full flex items-center gap-2 px-2.5 py-1.5 transition-all text-left",
          hasDetail && "hover:brightness-110",
        )}
      >
        {isLive ? (
          <Loader2 className="h-3 w-3 animate-spin shrink-0" />
        ) : (
          <Icon className="h-3 w-3 shrink-0" />
        )}
        <span className="font-medium shrink-0">{label}</span>
        {inlineSummary}
        {hasDetail && (
          <span className="shrink-0 ml-auto opacity-50">
            {expanded ? (
              <ChevronDown className="h-2.5 w-2.5" />
            ) : (
              <ChevronRight className="h-2.5 w-2.5" />
            )}
          </span>
        )}
      </button>

      {expanded && hasDetail && (
        <div className="px-2.5 pb-2 border-t border-current/10">
          {/* file_diff: rich diff body with +/- line coloring */}
          {diff?.diff ? (
            <DiffBody diff={diff.diff} />
          ) : /* command_output: command header + stdout/stderr */
          cmdOut ? (
            <div className="mt-1.5 space-y-1">
              {cmdOut.command && (
                <p className="text-[9px] font-mono text-muted-foreground/70">
                  <span className="text-cyan-400">$</span> {cmdOut.command}
                </p>
              )}
              {(cmdOut.stdout || cmdOut.stderr) && (
                <pre className="text-[9px] font-mono whitespace-pre-wrap opacity-75 max-h-32 overflow-y-auto">
                  {truncate(cmdOut.stdout ?? cmdOut.stderr ?? "", 600)}
                </pre>
              )}
              {cmdOut.exitCode !== undefined && cmdOut.exitCode !== 0 && (
                <p className="text-[9px] text-red-400 font-mono">exit {cmdOut.exitCode}</p>
              )}
            </div>
          ) : (
            /* generic fallback */
            <pre className="mt-1.5 text-[9px] font-mono whitespace-pre-wrap opacity-75 max-h-32 overflow-y-auto">
              {event.message}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

/** Status chip shown at the end of a completed tool-call sequence */
export function ToolCallStatusChip({
  status,
  count,
}: {
  status: "completed" | "failed" | "running";
  count: number;
}) {
  if (status === "running") {
    return (
      <div className="flex items-center gap-1.5 text-[9px] text-muted-foreground font-medium">
        <Loader2 className="h-2.5 w-2.5 animate-spin" />
        {count} action{count !== 1 ? "s" : ""} in progress…
      </div>
    );
  }
  if (status === "failed") {
    return (
      <div className="flex items-center gap-1.5 text-[9px] text-destructive font-medium">
        <AlertCircle className="h-2.5 w-2.5" />
        {count} action{count !== 1 ? "s" : ""} — failed
      </div>
    );
  }
  return (
    <div className="flex items-center gap-1.5 text-[9px] text-green-400 font-medium">
      <CheckCircle2 className="h-2.5 w-2.5" />
      {count} action{count !== 1 ? "s" : ""} completed
    </div>
  );
}

/** Renders a collapsible group of tool-call events for a task */
export function ToolCallGroup({
  events,
  taskStatus,
}: {
  events: ToolCallEvent[];
  taskStatus?: string;
}) {
  const [expanded, setExpanded] = useState(false);

  const TOOL_EVENT_TYPES = new Set([
    "read_file",
    "write_file",
    "apply_patch",
    "list_directory",
    "shell_command",
    "command_output",
    "web_search",
    "web_fetch",
    "take_screenshot",
    "generate_image",
    "file_diff",
    "tool_call",
    "thinking",
  ]);

  const toolEvents = events.filter((e) => TOOL_EVENT_TYPES.has(e.eventType));
  if (toolEvents.length === 0) return null;

  const isRunning = taskStatus === "running" || taskStatus === "queued";
  const isFailed = taskStatus === "failed" || taskStatus === "cancelled";
  const status = isRunning ? "running" : isFailed ? "failed" : "completed";

  return (
    <div className="flex flex-col gap-1 py-1 px-3">
      <button onClick={() => setExpanded((v) => !v)} className="flex items-center gap-1.5 w-full">
        <ToolCallStatusChip status={status} count={toolEvents.length} />
        <span className="text-[9px] text-muted-foreground/40 ml-auto">
          {expanded ? "hide" : "show"}
        </span>
      </button>

      {expanded && (
        <div className="flex flex-col gap-1 mt-1">
          {toolEvents.map((ev) => (
            <ToolCallCard key={ev.id} event={ev} isLive={isRunning} />
          ))}
        </div>
      )}
    </div>
  );
}
