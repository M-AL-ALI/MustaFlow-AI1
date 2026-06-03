import { authFetch } from "@/lib/api-fetch";
import { useEffect, useRef, useState, useCallback } from "react";
import { Terminal, Power, Loader2, AlertCircle, RefreshCw, Monitor } from "lucide-react";
import { cn } from "@/lib/utils";

type ContainerStatus = "stopped" | "starting" | "running" | "hibernated" | "error";

type LogLine = {
  id: number;
  text: string;
  type: "input" | "output" | "error" | "system" | "success";
};

let lineIdCounter = 0;

interface TerminalPanelProps {
  projectId: number;
  containerStatus: ContainerStatus;
  containerUrl: string | null;
  onStartContainer: () => void;
  isStarting: boolean;
}

function ConsoleTab({
  projectId,
  containerStatus,
}: {
  projectId: number;
  containerStatus: ContainerStatus;
  containerUrl?: string | null;
}) {
  const wsRef = useRef<WebSocket | null>(null);
  const [connected, setConnected] = useState(false);
  const [lines, setLines] = useState<LogLine[]>([]);
  const [inputValue, setInputValue] = useState("");
  const [wsError, setWsError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const outputRef = useRef<HTMLDivElement>(null);

  const addLine = useCallback((text: string, type: LogLine["type"]) => {
    setLines((prev) => [...prev.slice(-999), { id: lineIdCounter++, text, type }]);
  }, []);

  useEffect(() => {
    if (outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }
  }, [lines]);

  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return;
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const url = `${protocol}//${window.location.host}/api/projects/${projectId}/terminal`;
    const ws = new WebSocket(url);
    wsRef.current = ws;
    setWsError(null);

    ws.onopen = () => {
      setConnected(true);
      addLine("Terminal connected", "system");
    };

    ws.onmessage = (evt) => {
      const data = String(evt.data);
      if (data.startsWith("\x00")) {
        try {
          const msg = JSON.parse(data.slice(1)) as { type: string; message?: string };
          if (msg.type === "error") {
            setWsError(msg.message ?? "Unknown error");
            addLine(`Error: ${msg.message ?? "Unknown error"}`, "error");
          }
        } catch {
          /* ignore */
        }
        return;
      }
      const parts = data.split(/\r?\n/);
      for (const part of parts) {
        if (!part.trim()) continue;
        const isError = part.includes("[exit 1]") || part.includes("[31m");
        const isSuccess = part.includes("[exit 0]") || part.includes("[32m");
        // eslint-disable-next-line no-control-regex
        const clean = part.replace(/\x1b\[[0-9;]*m/g, "").replace(/^\$ /, "");
        if (clean) addLine(clean, isError ? "error" : isSuccess ? "success" : "output");
      }
    };

    ws.onclose = () => {
      setConnected(false);
      addLine("Disconnected", "system");
    };

    ws.onerror = () => {
      setWsError("Connection failed");
      setConnected(false);
    };
  }, [projectId, addLine]);

  const disconnect = useCallback(() => {
    wsRef.current?.close();
    wsRef.current = null;
    setConnected(false);
  }, []);

  useEffect(() => {
    if (containerStatus === "running") connect();
    else disconnect();
  }, [containerStatus, connect, disconnect]);

  const sendCommand = useCallback(() => {
    const cmd = inputValue.trim();
    if (!cmd || !wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    addLine(`$ ${cmd}`, "input");
    wsRef.current.send(cmd + "\r");
    setInputValue("");
  }, [inputValue, addLine]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Enter") sendCommand();
      else if (e.key === "c" && e.ctrlKey && wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send("\x03");
      }
    },
    [sendCommand],
  );

  return (
    <div className="flex flex-col h-full bg-[#0d0f17] font-mono text-sm">
      <div className="shrink-0 flex items-center gap-2 px-2 py-1 border-b border-border bg-zinc-950">
        <span
          className={cn(
            "flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-full border",
            connected
              ? "bg-green-500/10 text-green-400 border-green-500/20"
              : "bg-muted text-muted-foreground border-border",
          )}
        >
          <span
            className={cn(
              "w-1.5 h-1.5 rounded-full",
              connected ? "bg-green-400 animate-pulse" : "bg-muted-foreground",
            )}
          />
          {connected ? "Connected" : "Disconnected"}
        </span>
        <div className="flex-1" />
        <button
          onClick={() => setLines([])}
          className="text-[10px] text-muted-foreground hover:text-foreground transition-colors px-1.5 py-0.5 rounded hover:bg-muted"
        >
          Clear
        </button>
        {connected ? (
          <button
            onClick={disconnect}
            className="text-[10px] text-destructive hover:text-destructive/80 transition-colors px-1.5 py-0.5 rounded hover:bg-muted"
          >
            Disconnect
          </button>
        ) : (
          <button
            onClick={connect}
            className="text-[10px] text-green-400 hover:text-green-300 transition-colors px-1.5 py-0.5 rounded hover:bg-muted"
          >
            Reconnect
          </button>
        )}
      </div>

      {wsError && (
        <div className="shrink-0 flex items-center gap-2 px-2 py-1.5 bg-destructive/10 border-b border-destructive/20 text-xs text-destructive">
          <AlertCircle className="h-3 w-3 shrink-0" />
          {wsError}
          <button
            onClick={() => {
              setWsError(null);
              connect();
            }}
            className="ml-auto text-[10px] font-semibold border border-destructive/30 px-2 py-0.5 rounded hover:bg-destructive/20 transition-colors"
          >
            Retry
          </button>
        </div>
      )}

      <div
        ref={outputRef}
        className="flex-1 min-h-0 overflow-y-auto p-2 space-y-0.5 cursor-text"
        onClick={() => inputRef.current?.focus()}
      >
        {lines.length === 0 && (
          <div className="text-muted-foreground/40 text-[11px] pt-1">
            {containerStatus === "running"
              ? "Terminal ready. Type a command below."
              : "Start the container to use the terminal."}
          </div>
        )}
        {lines.map((line) => (
          <div
            key={line.id}
            className={cn(
              "text-[11px] leading-5 whitespace-pre-wrap break-all font-mono",
              line.type === "input" && "text-cyan-400",
              line.type === "output" && "text-zinc-300",
              line.type === "error" && "text-red-400",
              line.type === "success" && "text-green-400",
              line.type === "system" && "text-zinc-500 italic",
            )}
          >
            {line.text}
          </div>
        ))}
      </div>

      <div className="shrink-0 flex items-center gap-1.5 border-t border-border px-2 py-1.5 bg-[#0d0f17]">
        <span className="text-cyan-400 text-[11px] shrink-0">$</span>
        <input
          ref={inputRef}
          type="text"
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={!connected}
          placeholder={connected ? "Type a command…" : "Container not running"}
          className="flex-1 bg-transparent border-0 outline-none text-[11px] font-mono text-zinc-100 placeholder:text-zinc-600 disabled:opacity-40"
          spellCheck={false}
          autoComplete="off"
          autoCapitalize="off"
        />
        <button
          onClick={sendCommand}
          disabled={!connected || !inputValue.trim()}
          className="text-[10px] font-medium text-muted-foreground hover:text-foreground disabled:opacity-30 transition-colors px-1.5 py-0.5 rounded border border-border hover:border-primary/40 shrink-0"
        >
          Run
        </button>
      </div>
    </div>
  );
}

function LogsTab({ projectId }: { projectId: number }) {
  const [logs, setLogs] = useState<Array<{ level: string; message: string; createdAt: string }>>(
    [],
  );
  const [loading, setLoading] = useState(true);
  const bottomRef = useRef<HTMLDivElement>(null);

  const fetchLogs = useCallback(async () => {
    try {
      const res = await authFetch(`/api/projects/${projectId}/container/logs`);
      if (res.ok) {
        const raw = await res.json();
        const entries: Array<{ level: string; message: string; createdAt: string }> = Array.isArray(
          raw,
        )
          ? raw
          : ((raw as { logs?: typeof entries }).logs ?? []);
        setLogs(entries);
      }
    } catch {
      /* ignore */
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void fetchLogs();
    const interval = setInterval(() => void fetchLogs(), 5000);
    return () => clearInterval(interval);
  }, [fetchLogs]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full min-h-0 bg-[#0d0f17] font-mono">
      <div className="shrink-0 flex items-center justify-between px-2 py-1 border-b border-border bg-zinc-950">
        <span className="text-[10px] text-muted-foreground">Container logs</span>
        <button
          onClick={() => void fetchLogs()}
          className="text-[10px] text-muted-foreground hover:text-foreground"
        >
          <RefreshCw className="h-3 w-3" />
        </button>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto p-2">
        {logs.length === 0 ? (
          <div className="text-[11px] text-muted-foreground/40 pt-1">No logs yet</div>
        ) : (
          logs.map((log, i) => (
            <div
              key={i}
              className={cn(
                "text-[11px] leading-5 font-mono",
                log.level === "stderr"
                  ? "text-red-400"
                  : log.level === "system"
                    ? "text-zinc-500 italic"
                    : "text-zinc-300",
              )}
            >
              {log.message}
            </div>
          ))
        )}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}

type PanelTab = "console" | "logs";

export function TerminalPanel({
  projectId,
  containerStatus,
  onStartContainer,
  isStarting,
}: TerminalPanelProps) {
  const [activeTab, setActiveTab] = useState<PanelTab>("console");

  const TABS: Array<{
    id: PanelTab;
    label: string;
    icon: React.ComponentType<{ className?: string }>;
  }> = [
    { id: "console", label: "Console", icon: Terminal },
    { id: "logs", label: "Logs", icon: Monitor },
  ];

  return (
    <div className="flex flex-col h-full border-t border-border min-h-0">
      {/* Tab bar */}
      <div className="flex items-center gap-0 px-1 bg-zinc-950 border-b border-border shrink-0">
        {TABS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            onClick={() => setActiveTab(id)}
            className={cn(
              "flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-medium border-b-2 transition-colors",
              activeTab === id
                ? "border-primary text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            <Icon className="h-3.5 w-3.5" />
            {label}
          </button>
        ))}

        <div className="flex-1" />

        {containerStatus === "stopped" || containerStatus === "hibernated" ? (
          <button
            onClick={onStartContainer}
            disabled={isStarting}
            className="flex items-center gap-1 text-[10px] font-medium text-green-400 hover:text-green-300 px-2 py-1 rounded hover:bg-muted transition-colors"
          >
            {isStarting ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <Power className="h-3 w-3" />
            )}
            {isStarting ? "Starting…" : "Start Container"}
          </button>
        ) : containerStatus === "running" ? (
          <span className="flex items-center gap-1 text-[10px] text-green-400 px-2">
            <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />
            Running
          </span>
        ) : null}
      </div>

      {/* Tab content */}
      <div className="flex-1 min-h-0 overflow-hidden">
        {activeTab === "console" && (
          <ConsoleTab projectId={projectId} containerStatus={containerStatus} />
        )}
        {activeTab === "logs" && <LogsTab projectId={projectId} />}
      </div>
    </div>
  );
}
