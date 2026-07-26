import { useState, useEffect, useRef, useCallback } from "react";
import {
  Play,
  Square,
  SkipForward,
  CornerDownLeft,
  CornerUpLeft,
  RotateCcw,
  Circle,
  XCircle,
  AlertCircle,
  ChevronRight,
  ChevronDown,
  Loader2,
  Bug,
  FileCode2,
  Minus,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { LiveServerRequired } from "./live-server-required";

type DebugStatus = "idle" | "connecting" | "running" | "paused" | "stopped" | "error";

interface Breakpoint {
  id: number;
  fileId: number;
  path: string;
  line: number;
  enabled: boolean;
  condition?: string;
  hitCount: number;
}

interface StackFrame {
  id: number;
  name: string;
  path: string;
  line: number;
  column: number;
}

interface Variable {
  name: string;
  value: string;
  type: string;
  hasChildren?: boolean;
  expanded?: boolean;
  children?: Variable[];
}

interface DebuggerPanelProps {
  projectId: number;
  containerStatus?: string;
  onJumpToLine?: (fileId: number, line: number) => void;
  files?: Array<{ id: number; path: string }>;
  containerLayerConfigured: boolean;
}

function VariableRow({ variable, depth = 0 }: { variable: Variable; depth?: number }) {
  const [expanded, setExpanded] = useState(variable.expanded ?? false);

  return (
    <div>
      <div
        className={cn(
          "flex items-start gap-1 py-0.5 hover:bg-muted/40 rounded transition-colors cursor-default group",
          "text-[11px] font-mono",
        )}
        style={{ paddingLeft: `${(depth + 1) * 12}px` }}
      >
        {variable.hasChildren ? (
          <button
            onClick={() => setExpanded((v) => !v)}
            className="shrink-0 mt-px text-muted-foreground hover:text-foreground"
          >
            {expanded ? (
              <ChevronDown className="h-2.5 w-2.5" />
            ) : (
              <ChevronRight className="h-2.5 w-2.5" />
            )}
          </button>
        ) : (
          <Minus className="h-2.5 w-2.5 text-transparent shrink-0 mt-px" />
        )}
        <span className="text-blue-400">{variable.name}</span>
        <span className="text-muted-foreground mx-1">=</span>
        <span className="text-green-400 flex-1 min-w-0 truncate">{variable.value}</span>
        <span className="text-muted-foreground/50 text-[10px] shrink-0 mr-1 opacity-0 group-hover:opacity-100">
          {variable.type}
        </span>
      </div>
      {expanded && variable.children && (
        <div>
          {variable.children.map((child, i) => (
            <VariableRow key={i} variable={child} depth={depth + 1} />
          ))}
        </div>
      )}
    </div>
  );
}

function BreakpointRow({
  bp,
  onToggle,
  onRemove,
  onJump,
}: {
  bp: Breakpoint;
  onToggle: (id: number) => void;
  onRemove: (id: number) => void;
  onJump: (fileId: number, line: number) => void;
}) {
  return (
    <div className="flex items-center gap-2 px-2 py-1 hover:bg-muted/40 rounded group">
      <button onClick={() => onToggle(bp.id)} className="shrink-0">
        {bp.enabled ? (
          <Circle className="h-3 w-3 text-red-500 fill-red-500" />
        ) : (
          <Circle className="h-3 w-3 text-muted-foreground" />
        )}
      </button>
      <button
        onClick={() => onJump(bp.fileId, bp.line)}
        className="flex-1 min-w-0 text-left flex items-center gap-1.5"
      >
        <FileCode2 className="h-3 w-3 text-muted-foreground shrink-0" />
        <span className="text-[11px] text-foreground truncate">{bp.path}</span>
        <span className="text-[10px] text-muted-foreground shrink-0">:{bp.line}</span>
      </button>
      {bp.hitCount > 0 && (
        <span className="text-[10px] text-muted-foreground shrink-0 bg-muted px-1 rounded">
          {bp.hitCount}x
        </span>
      )}
      <button
        onClick={() => onRemove(bp.id)}
        className="shrink-0 opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive transition-colors"
      >
        <XCircle className="h-3 w-3" />
      </button>
    </div>
  );
}

export function DebuggerPanel({
  projectId,
  containerStatus,
  onJumpToLine,
  files: _files = [],
  containerLayerConfigured,
}: DebuggerPanelProps) {
  const [status, setStatus] = useState<DebugStatus>("idle");
  const [breakpoints, setBreakpoints] = useState<Breakpoint[]>([]);
  const [stackFrames, setStackFrames] = useState<StackFrame[]>([]);
  const [variables, setVariables] = useState<Variable[]>([]);
  const [watchExprs, setWatchExprs] = useState<Array<{ expr: string; value: string }>>([]);
  const [newWatchExpr, setNewWatchExpr] = useState("");
  const [activePanel, setActivePanel] = useState<
    "variables" | "watch" | "call-stack" | "breakpoints"
  >("variables");
  const [consoleOutput, setConsoleOutput] = useState<Array<{ kind: "out" | "err"; text: string }>>(
    [],
  );
  const wsRef = useRef<WebSocket | null>(null);

  const isContainerRunning = containerStatus === "running";

  const connect = useCallback(() => {
    if (!isContainerRunning) return;
    setStatus("connecting");
    setConsoleOutput((p) => [...p, { kind: "out", text: "Connecting to debug adapter…" }]);

    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${proto}//${window.location.host}/api/projects/${projectId}/debug`);
    wsRef.current = ws;

    ws.onopen = () => {
      setStatus("running");
      setConsoleOutput((p) => [...p, { kind: "out", text: "Debug adapter connected." }]);
      ws.send(JSON.stringify({ type: "initialize" }));
    };

    ws.onmessage = (event: MessageEvent) => {
      try {
        const msg = JSON.parse(event.data as string) as {
          type: string;
          [key: string]: unknown;
        };
        if (msg.type === "stopped") {
          setStatus("paused");
          if (msg.stackTrace) {
            setStackFrames((msg.stackTrace as StackFrame[]) ?? []);
          }
          if (msg.variables) {
            setVariables((msg.variables as Variable[]) ?? []);
          }
        } else if (msg.type === "continued") {
          setStatus("running");
          setStackFrames([]);
          setVariables([]);
        } else if (msg.type === "terminated") {
          setStatus("stopped");
          setStackFrames([]);
          setVariables([]);
          setConsoleOutput((p) => [...p, { kind: "out", text: "Debug session ended." }]);
        } else if (msg.type === "evaluate-result") {
          const expr = String(msg.expression ?? "");
          const result = String(msg.result ?? "");
          setWatchExprs((p) => p.map((w) => (w.expr === expr ? { ...w, value: result } : w)));
        } else if (msg.type === "output") {
          const text = String(msg.output ?? "");
          const category = String(msg.category ?? "console");
          setConsoleOutput((p) => [
            ...p.slice(-200),
            { kind: category === "stderr" ? "err" : "out", text },
          ]);
        }
      } catch {
        // ignore parse errors
      }
    };

    ws.onerror = () => {
      setStatus("error");
      setConsoleOutput((p) => [...p, { kind: "err", text: "Debug adapter connection error." }]);
    };

    ws.onclose = () => {
      if (status !== "stopped") {
        setStatus("idle");
      }
      wsRef.current = null;
    };
  }, [projectId, isContainerRunning, status]);

  const sendCmd = useCallback((cmd: object) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(cmd));
    }
  }, []);

  const disconnect = useCallback(() => {
    wsRef.current?.close();
    setStatus("idle");
    setStackFrames([]);
    setVariables([]);
  }, []);

  useEffect(() => {
    return () => {
      wsRef.current?.close();
    };
  }, []);

  function toggleBreakpoint(id: number) {
    setBreakpoints((bps) => bps.map((b) => (b.id === id ? { ...b, enabled: !b.enabled } : b)));
  }

  function removeBreakpoint(id: number) {
    setBreakpoints((bps) => bps.filter((b) => b.id !== id));
    sendCmd({ type: "removeBreakpoint", id });
  }

  function addWatchExpr() {
    const expr = newWatchExpr.trim();
    if (!expr) return;
    setWatchExprs((p) => [...p, { expr, value: "<pending>" }]);
    setNewWatchExpr("");
    sendCmd({ type: "evaluate", expression: expr });
  }

  const statusColor: Record<DebugStatus, string> = {
    idle: "text-muted-foreground",
    connecting: "text-yellow-400",
    running: "text-green-400",
    paused: "text-orange-400",
    stopped: "text-muted-foreground",
    error: "text-destructive",
  };

  const statusLabel: Record<DebugStatus, string> = {
    idle: "Not connected",
    connecting: "Connecting…",
    running: "Running",
    paused: "Paused",
    stopped: "Stopped",
    error: "Error",
  };

  if (!containerLayerConfigured) return <LiveServerRequired />;

  return (
    <div className="flex flex-col h-full min-h-0 bg-background text-foreground">
      {/* Toolbar */}
      <div className="flex items-center gap-1 px-2 py-1.5 border-b border-border bg-card shrink-0">
        <div className="flex items-center gap-1">
          {status === "idle" || status === "stopped" || status === "error" ? (
            <button
              onClick={connect}
              disabled={!isContainerRunning}
              className="flex items-center gap-1.5 text-[11px] px-2 py-1 rounded bg-green-600 text-white hover:bg-green-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              title="Start debugging (F5)"
            >
              <Play className="h-3 w-3" />
              Start
            </button>
          ) : (
            <button
              onClick={disconnect}
              className="p-1.5 rounded text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
              title="Stop (Shift+F5)"
            >
              <Square className="h-3.5 w-3.5" />
            </button>
          )}

          <button
            onClick={() => sendCmd({ type: "continue" })}
            disabled={status !== "paused"}
            className="p-1.5 rounded text-muted-foreground hover:text-foreground hover:bg-muted disabled:opacity-30 transition-colors"
            title="Continue (F5)"
          >
            <Play className="h-3.5 w-3.5" />
          </button>

          <button
            onClick={() => sendCmd({ type: "stepOver" })}
            disabled={status !== "paused"}
            className="p-1.5 rounded text-muted-foreground hover:text-foreground hover:bg-muted disabled:opacity-30 transition-colors"
            title="Step over (F10)"
          >
            <SkipForward className="h-3.5 w-3.5" />
          </button>

          <button
            onClick={() => sendCmd({ type: "stepInto" })}
            disabled={status !== "paused"}
            className="p-1.5 rounded text-muted-foreground hover:text-foreground hover:bg-muted disabled:opacity-30 transition-colors"
            title="Step into (F11)"
          >
            <CornerDownLeft className="h-3.5 w-3.5" />
          </button>

          <button
            onClick={() => sendCmd({ type: "stepOut" })}
            disabled={status !== "paused"}
            className="p-1.5 rounded text-muted-foreground hover:text-foreground hover:bg-muted disabled:opacity-30 transition-colors"
            title="Step out (Shift+F11)"
          >
            <CornerUpLeft className="h-3.5 w-3.5" />
          </button>

          <button
            onClick={() => {
              disconnect();
              setTimeout(connect, 300);
            }}
            disabled={status === "idle"}
            className="p-1.5 rounded text-muted-foreground hover:text-foreground hover:bg-muted disabled:opacity-30 transition-colors"
            title="Restart (Ctrl+Shift+F5)"
          >
            <RotateCcw className="h-3.5 w-3.5" />
          </button>
        </div>

        <div className="ml-auto flex items-center gap-1.5">
          {status === "connecting" && <Loader2 className="h-3 w-3 animate-spin text-yellow-400" />}
          <span className={cn("text-[10px] font-medium", statusColor[status])}>
            {statusLabel[status]}
          </span>
        </div>
      </div>

      {!isContainerRunning && (
        <div className="px-3 py-2.5 bg-yellow-500/10 border-b border-yellow-500/20 flex items-start gap-2 shrink-0">
          <AlertCircle className="h-3.5 w-3.5 text-yellow-400 shrink-0 mt-0.5" />
          <p className="text-[11px] text-yellow-400">
            Start a container from the Preview tab to enable debugging. The debugger connects to the
            Node.js / Python DAP adapter running inside the project container.
          </p>
        </div>
      )}

      {/* Sub-panel tabs */}
      <div className="flex border-b border-border bg-muted/30 shrink-0">
        {(["variables", "watch", "call-stack", "breakpoints"] as const).map((panel) => (
          <button
            key={panel}
            onClick={() => setActivePanel(panel)}
            className={cn(
              "text-[11px] px-3 py-1.5 capitalize transition-colors border-b-2",
              activePanel === panel
                ? "border-primary text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {panel === "call-stack" ? "Call Stack" : panel.charAt(0).toUpperCase() + panel.slice(1)}
            {panel === "breakpoints" && breakpoints.length > 0 && (
              <span className="ml-1 text-[9px] bg-primary text-primary-foreground rounded-full px-1">
                {breakpoints.length}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* Panel body */}
      <div className="flex-1 overflow-y-auto min-h-0">
        {activePanel === "variables" && (
          <div className="py-1">
            {variables.length === 0 ? (
              <div className="px-3 py-6 text-center">
                <Bug className="h-6 w-6 text-muted-foreground/20 mx-auto mb-2" />
                <div className="text-[11px] text-muted-foreground">
                  {status === "paused"
                    ? "No variables available"
                    : "Paused on a breakpoint to inspect variables"}
                </div>
              </div>
            ) : (
              variables.map((v, i) => <VariableRow key={i} variable={v} />)
            )}
          </div>
        )}

        {activePanel === "watch" && (
          <div className="py-1">
            <div className="px-2 py-1 border-b border-border/30 flex items-center gap-1">
              <input
                value={newWatchExpr}
                onChange={(e) => setNewWatchExpr(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") addWatchExpr();
                }}
                placeholder="Add expression to watch…"
                className="flex-1 text-[11px] font-mono bg-background border border-border/60 rounded px-2 py-0.5 text-foreground placeholder:text-muted-foreground/40 focus:outline-none focus:ring-1 focus:ring-primary"
              />
            </div>
            {watchExprs.length === 0 ? (
              <div className="px-3 py-4 text-[11px] text-muted-foreground text-center">
                No watch expressions
              </div>
            ) : (
              watchExprs.map((w, i) => (
                <div
                  key={i}
                  className="flex items-center gap-2 px-2 py-1 font-mono text-[11px] hover:bg-muted/40 group"
                >
                  <span className="text-blue-400">{w.expr}</span>
                  <span className="text-muted-foreground mx-1">=</span>
                  <span className="text-green-400 flex-1 truncate">{w.value}</span>
                  <button
                    onClick={() => setWatchExprs((p) => p.filter((_, j) => j !== i))}
                    className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive"
                  >
                    <XCircle className="h-3 w-3" />
                  </button>
                </div>
              ))
            )}
          </div>
        )}

        {activePanel === "call-stack" && (
          <div className="py-1">
            {stackFrames.length === 0 ? (
              <div className="px-3 py-6 text-center">
                <div className="text-[11px] text-muted-foreground">
                  {status === "paused" ? "Empty call stack" : "Not paused"}
                </div>
              </div>
            ) : (
              stackFrames.map((frame, i) => (
                <button
                  key={frame.id}
                  onClick={() => onJumpToLine?.(0, frame.line)}
                  className={cn(
                    "w-full text-left flex items-start gap-2 px-3 py-1.5 hover:bg-muted/40 transition-colors",
                    i === 0 && "bg-primary/5",
                  )}
                >
                  <span className="text-[10px] text-muted-foreground shrink-0 mt-0.5 w-4 text-right">
                    {i}
                  </span>
                  <div className="flex-1 min-w-0">
                    <div className="text-[11px] font-mono text-foreground truncate">
                      {frame.name}
                    </div>
                    <div className="text-[10px] text-muted-foreground truncate">
                      {frame.path}:{frame.line}:{frame.column}
                    </div>
                  </div>
                </button>
              ))
            )}
          </div>
        )}

        {activePanel === "breakpoints" && (
          <div className="py-1">
            {breakpoints.length === 0 ? (
              <div className="px-3 py-6 text-center">
                <Circle className="h-5 w-5 text-muted-foreground/20 mx-auto mb-2" />
                <div className="text-[11px] text-muted-foreground">No breakpoints set</div>
                <div className="text-[10px] text-muted-foreground/60 mt-0.5">
                  Click in the editor gutter or press F9
                </div>
              </div>
            ) : (
              breakpoints.map((bp) => (
                <BreakpointRow
                  key={bp.id}
                  bp={bp}
                  onToggle={toggleBreakpoint}
                  onRemove={removeBreakpoint}
                  onJump={(fileId, line) => onJumpToLine?.(fileId, line)}
                />
              ))
            )}
          </div>
        )}
      </div>

      {/* Console strip */}
      <div className="border-t border-border shrink-0">
        <div className="px-2 py-1 flex items-center justify-between">
          <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
            Console
          </span>
          <button
            onClick={() => setConsoleOutput([])}
            className="text-[10px] text-muted-foreground hover:text-foreground transition-colors"
          >
            Clear
          </button>
        </div>
        <div className="h-24 overflow-y-auto bg-muted/30 px-2 pb-1 font-mono text-[10px] space-y-px">
          {consoleOutput.length === 0 && (
            <div className="text-muted-foreground/40 py-1">No output yet</div>
          )}
          {consoleOutput.map((line, i) => (
            <div
              key={i}
              className={cn(
                "leading-relaxed",
                line.kind === "err" ? "text-destructive" : "text-foreground/80",
              )}
            >
              {line.text}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
