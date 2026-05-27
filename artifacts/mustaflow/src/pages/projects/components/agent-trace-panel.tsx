import { useState } from "react";
import { useGetTaskTrace } from "@workspace/api-client-react";
import type { AgentTraceResponse } from "@workspace/api-client-react";
import { cn } from "@/lib/utils";
import {
  Terminal,
  FileCode2,
  Globe,
  Camera,
  Search,
  Wrench,
  CheckCircle2,
  XCircle,
  Clock,
  ChevronDown,
  ChevronRight,
  Loader2,
  AlertTriangle,
  ShieldAlert,
  Cpu,
  Package,
  Activity,
  BookOpen,
  X,
} from "lucide-react";

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function truncate(str: string, max = 120): string {
  if (!str || str.length <= max) return str;
  return str.slice(0, max) + "…";
}

function toolIcon(toolName: string) {
  const name = toolName.toLowerCase();
  if (
    name.includes("file") ||
    name.includes("read") ||
    name.includes("write") ||
    name.includes("edit")
  ) {
    return FileCode2;
  }
  if (
    name.includes("terminal") ||
    name.includes("command") ||
    name.includes("run") ||
    name.includes("bash") ||
    name.includes("exec")
  ) {
    return Terminal;
  }
  if (
    name.includes("web") ||
    name.includes("fetch") ||
    name.includes("url") ||
    name.includes("http")
  ) {
    return Globe;
  }
  if (
    name.includes("screenshot") ||
    name.includes("camera") ||
    name.includes("image") ||
    name.includes("photo")
  ) {
    return Camera;
  }
  if (
    name.includes("search") ||
    name.includes("grep") ||
    name.includes("glob") ||
    name.includes("find")
  ) {
    return Search;
  }
  if (name.includes("package") || name.includes("install") || name.includes("pkg")) {
    return Package;
  }
  if (name.includes("skill") || name.includes("knowledge") || name.includes("learn")) {
    return BookOpen;
  }
  return Wrench;
}

function argsPreview(args: Record<string, unknown>): string {
  const entries = Object.entries(args);
  if (entries.length === 0) return "";
  const [key, val] = entries[0]!;
  const strVal = typeof val === "string" ? val : JSON.stringify(val);
  return truncate(`${key}: ${strVal}`, 80);
}

interface ToolCallRowProps {
  toolCall: NonNullable<AgentTraceResponse["agentLoop"]>["toolCalls"][number];
}

function ToolCallRow({ toolCall }: ToolCallRowProps) {
  const [expanded, setExpanded] = useState(false);
  const Icon = toolIcon(toolCall.tool);
  const hasDetail = toolCall.preview && toolCall.preview.trim().length > 0;

  return (
    <div
      className={cn(
        "rounded border text-[11px]",
        toolCall.ok ? "border-border/50 bg-card/40" : "border-red-900/50 bg-red-950/20",
      )}
    >
      <button
        onClick={() => hasDetail && setExpanded((v) => !v)}
        className={cn(
          "w-full flex items-center gap-2 px-2.5 py-1.5 text-left",
          hasDetail ? "cursor-pointer hover:bg-muted/30 transition-colors" : "cursor-default",
        )}
      >
        <Icon
          className={cn("h-3.5 w-3.5 shrink-0", toolCall.ok ? "text-primary/70" : "text-red-400")}
        />
        <span
          className={cn(
            "font-mono font-medium shrink-0",
            toolCall.ok ? "text-foreground" : "text-red-400",
          )}
        >
          {toolCall.tool}
        </span>
        <span className="text-muted-foreground/70 flex-1 min-w-0 truncate">
          {argsPreview(toolCall.args)}
        </span>
        <span className="text-muted-foreground/50 shrink-0 text-[10px]">
          {formatDuration(toolCall.durationMs)}
        </span>
        {toolCall.ok ? (
          <CheckCircle2 className="h-3 w-3 text-green-500 shrink-0" />
        ) : (
          <XCircle className="h-3 w-3 text-red-400 shrink-0" />
        )}
        {hasDetail &&
          (expanded ? (
            <ChevronDown className="h-3 w-3 text-muted-foreground/40 shrink-0" />
          ) : (
            <ChevronRight className="h-3 w-3 text-muted-foreground/40 shrink-0" />
          ))}
      </button>
      {expanded && hasDetail && (
        <div className="px-2.5 pb-2 pt-0">
          <pre className="text-[10px] text-muted-foreground bg-muted/40 border border-border/40 rounded p-2 overflow-x-auto whitespace-pre-wrap font-mono leading-relaxed max-h-40">
            {toolCall.preview}
          </pre>
        </div>
      )}
    </div>
  );
}

interface CommandRowProps {
  cmd: NonNullable<AgentTraceResponse["agentLoop"]>["commandsRun"][number];
}

function CommandRow({ cmd }: CommandRowProps) {
  const [expanded, setExpanded] = useState(false);
  const ok = cmd.exitCode === 0;
  const hasOutput =
    (cmd.stdoutPreview && cmd.stdoutPreview.trim()) ||
    (cmd.stderrPreview && cmd.stderrPreview.trim());

  return (
    <div
      className={cn(
        "rounded border text-[11px]",
        ok ? "border-border/50 bg-card/40" : "border-red-900/50 bg-red-950/20",
      )}
    >
      <button
        onClick={() => hasOutput && setExpanded((v) => !v)}
        className={cn(
          "w-full flex items-center gap-2 px-2.5 py-1.5 text-left",
          hasOutput ? "cursor-pointer hover:bg-muted/30 transition-colors" : "cursor-default",
        )}
      >
        <Terminal className={cn("h-3.5 w-3.5 shrink-0", ok ? "text-primary/70" : "text-red-400")} />
        <span
          className={cn(
            "font-mono font-medium flex-1 min-w-0 truncate",
            ok ? "text-foreground" : "text-red-400",
          )}
        >
          {cmd.argv.join(" ")}
        </span>
        <span className="text-muted-foreground/50 shrink-0 text-[10px]">
          {formatDuration(cmd.durationMs)}
        </span>
        <span
          className={cn(
            "text-[10px] font-semibold px-1.5 py-0.5 rounded shrink-0",
            ok
              ? "text-green-400 bg-green-950/40 border border-green-900/40"
              : "text-red-400 bg-red-950/40 border border-red-900/40",
          )}
        >
          exit {cmd.exitCode}
        </span>
        {hasOutput &&
          (expanded ? (
            <ChevronDown className="h-3 w-3 text-muted-foreground/40 shrink-0" />
          ) : (
            <ChevronRight className="h-3 w-3 text-muted-foreground/40 shrink-0" />
          ))}
      </button>
      {expanded && hasOutput && (
        <div className="px-2.5 pb-2 pt-0 space-y-1">
          {cmd.stdoutPreview && cmd.stdoutPreview.trim() && (
            <div>
              <div className="text-[9px] font-semibold text-muted-foreground/50 uppercase tracking-wide mb-0.5">
                stdout
              </div>
              <pre className="text-[10px] text-muted-foreground bg-muted/40 border border-border/40 rounded p-2 overflow-x-auto whitespace-pre-wrap font-mono leading-relaxed max-h-32">
                {cmd.stdoutPreview}
              </pre>
            </div>
          )}
          {cmd.stderrPreview && cmd.stderrPreview.trim() && (
            <div>
              <div className="text-[9px] font-semibold text-red-400/70 uppercase tracking-wide mb-0.5">
                stderr
              </div>
              <pre className="text-[10px] text-red-300/70 bg-red-950/20 border border-red-900/30 rounded p-2 overflow-x-auto whitespace-pre-wrap font-mono leading-relaxed max-h-32">
                {cmd.stderrPreview}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

interface CheckResultRowProps {
  check: NonNullable<AgentTraceResponse["agentLoop"]>["checkResults"][number];
}

function CheckResultRow({ check }: CheckResultRowProps) {
  return (
    <div
      className={cn(
        "rounded border text-[11px] px-2.5 py-1.5 flex items-center gap-2",
        check.passed ? "border-border/50 bg-card/40" : "border-red-900/50 bg-red-950/20",
      )}
    >
      {check.passed ? (
        <CheckCircle2 className="h-3.5 w-3.5 text-green-500 shrink-0" />
      ) : (
        <XCircle className="h-3.5 w-3.5 text-red-400 shrink-0" />
      )}
      <Activity
        className={cn("h-3.5 w-3.5 shrink-0", check.passed ? "text-primary/70" : "text-red-400")}
      />
      <span
        className={cn("font-medium shrink-0", check.passed ? "text-foreground" : "text-red-400")}
      >
        {check.label}
      </span>
      {check.message && (
        <span className="text-muted-foreground/70 flex-1 min-w-0 truncate">{check.message}</span>
      )}
      <span className="text-muted-foreground/50 shrink-0 text-[10px]">
        {formatDuration(check.durationMs)}
      </span>
    </div>
  );
}

interface BlockedCommandRowProps {
  row: NonNullable<AgentTraceResponse["toolAudit"]>[number];
}

function BlockedCommandRow({ row }: BlockedCommandRowProps) {
  return (
    <div className="rounded border border-yellow-900/50 bg-yellow-950/20 text-[11px] px-2.5 py-1.5 flex items-start gap-2">
      <ShieldAlert className="h-3.5 w-3.5 text-yellow-400 shrink-0 mt-0.5" />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-mono text-yellow-300 font-medium">{row.argv.join(" ")}</span>
          <span className="text-[9px] font-semibold px-1 py-0.5 rounded bg-yellow-950/60 border border-yellow-900/40 text-yellow-400 uppercase tracking-wide shrink-0">
            blocked
          </span>
        </div>
        {row.blockReason && (
          <div className="text-[10px] text-yellow-400/70 mt-0.5">{row.blockReason}</div>
        )}
      </div>
    </div>
  );
}

interface AgentTracePanelProps {
  projectId: number;
  taskId: number;
  isAdmin?: boolean;
  onClose?: () => void;
}

export function AgentTracePanel({ projectId, taskId, isAdmin, onClose }: AgentTracePanelProps) {
  const { data, isLoading, isError } = useGetTaskTrace(projectId, taskId);

  const agentLoop = data?.agentLoop ?? null;
  const toolAudit = data?.toolAudit ?? [];
  const blockedCalls = toolAudit.filter((r) => r.blocked);

  const failedToolCalls = agentLoop?.toolCalls.filter((tc) => !tc.ok) ?? [];
  const failedCommands = agentLoop?.commandsRun.filter((c) => c.exitCode !== 0) ?? [];
  const failedChecks = agentLoop?.checkResults.filter((c) => !c.passed) ?? [];
  const hasFailures = failedToolCalls.length + failedCommands.length + failedChecks.length > 0;

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border/50 shrink-0">
        <Cpu className="h-3.5 w-3.5 text-primary/70 shrink-0" />
        <span className="text-[11px] font-semibold text-foreground flex-1">Agent Trace</span>
        {agentLoop && (
          <div className="flex items-center gap-2 text-[10px] text-muted-foreground/60">
            <span>{agentLoop.totalToolCalls} tool calls</span>
            <span>·</span>
            <span>{agentLoop.commandsRun.length} commands</span>
            <span>·</span>
            <span>{agentLoop.stack}</span>
          </div>
        )}
        {onClose && (
          <button
            onClick={onClose}
            className="w-5 h-5 flex items-center justify-center text-muted-foreground hover:text-foreground transition-colors shrink-0"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      {/* Body */}
      <div className="flex-1 min-h-0 overflow-y-auto p-3 space-y-4">
        {isLoading && (
          <div className="flex items-center justify-center h-20 gap-2 text-muted-foreground text-[11px]">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Loading trace…
          </div>
        )}

        {isError && (
          <div className="flex items-center gap-2 text-destructive text-[11px] bg-destructive/10 border border-destructive/30 rounded-lg px-3 py-2">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
            Failed to load trace data.
          </div>
        )}

        {!isLoading && !isError && !agentLoop && toolAudit.length === 0 && (
          <div className="flex flex-col items-center justify-center h-20 gap-2 text-muted-foreground">
            <Cpu className="h-7 w-7 opacity-20" />
            <div className="text-center">
              <div className="text-xs font-medium text-foreground/60">No trace available</div>
              <div className="text-[10px] opacity-50 mt-0.5">
                Trace data is recorded for agentic builds only
              </div>
            </div>
          </div>
        )}

        {/* Summary row */}
        {agentLoop && (
          <div className="grid grid-cols-4 gap-1.5 text-[10px]">
            <div className="bg-muted rounded p-1.5 text-center">
              <div className="text-muted-foreground/60 uppercase tracking-wide text-[9px]">
                Steps
              </div>
              <div className="font-semibold text-foreground">{agentLoop.steps}</div>
            </div>
            <div className="bg-muted rounded p-1.5 text-center">
              <div className="text-muted-foreground/60 uppercase tracking-wide text-[9px]">
                Tool calls
              </div>
              <div className="font-semibold text-foreground">{agentLoop.totalToolCalls}</div>
            </div>
            <div className="bg-muted rounded p-1.5 text-center">
              <div className="text-muted-foreground/60 uppercase tracking-wide text-[9px]">
                Commands
              </div>
              <div className="font-semibold text-foreground">{agentLoop.commandsRun.length}</div>
            </div>
            <div
              className={cn(
                "rounded p-1.5 text-center",
                hasFailures ? "bg-red-950/30" : "bg-muted",
              )}
            >
              <div
                className={cn(
                  "uppercase tracking-wide text-[9px]",
                  hasFailures ? "text-red-400/70" : "text-muted-foreground/60",
                )}
              >
                Failures
              </div>
              <div
                className={cn("font-semibold", hasFailures ? "text-red-400" : "text-foreground")}
              >
                {failedToolCalls.length + failedCommands.length + failedChecks.length}
              </div>
            </div>
          </div>
        )}

        {/* Termination reason */}
        {agentLoop && (
          <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground/70 bg-muted/40 border border-border/40 rounded px-2.5 py-1.5">
            <Clock className="h-3 w-3 shrink-0" />
            <span className="font-medium text-foreground/70">Terminated:</span>
            <span>{agentLoop.terminationReason}</span>
            {agentLoop.skillsLoaded && agentLoop.skillsLoaded.length > 0 && (
              <>
                <span className="ml-auto font-medium text-foreground/70">Skills:</span>
                <span>{agentLoop.skillsLoaded.join(", ")}</span>
              </>
            )}
          </div>
        )}

        {/* Tool calls timeline */}
        {agentLoop && agentLoop.toolCalls.length > 0 && (
          <div className="space-y-1.5">
            <div className="text-[9px] font-semibold text-muted-foreground/50 uppercase tracking-wider">
              Tool calls ({agentLoop.toolCalls.length})
            </div>
            <div className="space-y-1">
              {agentLoop.toolCalls.map((tc, i) => (
                <ToolCallRow key={i} toolCall={tc} />
              ))}
            </div>
          </div>
        )}

        {/* Commands run */}
        {agentLoop && agentLoop.commandsRun.length > 0 && (
          <div className="space-y-1.5">
            <div className="text-[9px] font-semibold text-muted-foreground/50 uppercase tracking-wider">
              Commands ({agentLoop.commandsRun.length})
            </div>
            <div className="space-y-1">
              {agentLoop.commandsRun.map((cmd, i) => (
                <CommandRow key={i} cmd={cmd} />
              ))}
            </div>
          </div>
        )}

        {/* Check results */}
        {agentLoop && agentLoop.checkResults.length > 0 && (
          <div className="space-y-1.5">
            <div className="text-[9px] font-semibold text-muted-foreground/50 uppercase tracking-wider">
              Checks ({agentLoop.checkResults.length})
            </div>
            <div className="space-y-1">
              {agentLoop.checkResults.map((c, i) => (
                <CheckResultRow key={i} check={c} />
              ))}
            </div>
          </div>
        )}

        {/* Admin: blocked commands */}
        {isAdmin && blockedCalls.length > 0 && (
          <div className="space-y-1.5">
            <div className="text-[9px] font-semibold text-yellow-500/70 uppercase tracking-wider flex items-center gap-1">
              <ShieldAlert className="h-3 w-3" />
              Blocked commands — admin view ({blockedCalls.length})
            </div>
            <div className="space-y-1">
              {blockedCalls.map((row) => (
                <BlockedCommandRow key={row.id} row={row} />
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
