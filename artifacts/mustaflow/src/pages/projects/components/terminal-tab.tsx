import { useEffect, useRef, useState, useCallback } from "react";
import {
  Terminal,
  Power,
  PowerOff,
  Loader2,
  AlertCircle,
  RefreshCw,
  Zap,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

type ContainerStatus = "stopped" | "starting" | "running" | "hibernated" | "error";

type TerminalTabProps = {
  projectId: number;
  containerStatus: ContainerStatus;
  containerUrl: string | null;
  onStartContainer: () => void;
  onStopContainer: () => void;
  isStarting: boolean;
};

type LogLine = {
  id: number;
  text: string;
  type: "input" | "output" | "error" | "system" | "success";
};

let lineIdCounter = 0;

export function TerminalTab({
  projectId,
  containerStatus,
  containerUrl,
  onStartContainer,
  onStopContainer,
  isStarting,
}: TerminalTabProps) {
  const wsRef = useRef<WebSocket | null>(null);
  const [connected, setConnected] = useState(false);
  const [lines, setLines] = useState<LogLine[]>([]);
  const [inputValue, setInputValue] = useState("");
  const [wsError, setWsError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const outputRef = useRef<HTMLDivElement>(null);

  const addLine = useCallback((text: string, type: LogLine["type"]) => {
    setLines((prev) => [
      ...prev.slice(-499),
      { id: lineIdCounter++, text, type },
    ]);
  }, []);

  const scrollToBottom = useCallback(() => {
    if (outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [lines, scrollToBottom]);

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
      // Control message
      if (data.startsWith("\x00")) {
        try {
          const msg = JSON.parse(data.slice(1)) as { type: string; message?: string };
          if (msg.type === "error") {
            setWsError(msg.message ?? "Unknown error");
            addLine(`Error: ${msg.message ?? "Unknown error"}`, "error");
          } else if (msg.type === "status") {
            // Ignore status pings
          }
        } catch {
          // ignore malformed control frames
        }
        return;
      }
      // Regular terminal output — split on CR+LF or LF
      const parts = data.split(/\r?\n/);
      for (const part of parts) {
        if (part.trim() === "") continue;
        // Detect ANSI exit codes for coloring
        const isError = part.includes("[exit 1]") || part.includes("[31m");
        const isSuccess = part.includes("[exit 0]") || part.includes("[32m");
        // Strip ANSI escape codes for display
        // eslint-disable-next-line no-control-regex
        const clean = part.replace(/\x1b\[[0-9;]*m/g, "").replace(/^\$ /, "");
        if (clean) {
          addLine(clean, isError ? "error" : isSuccess ? "success" : "output");
        }
      }
    };

    ws.onclose = () => {
      setConnected(false);
      addLine("Disconnected from terminal", "system");
    };

    ws.onerror = () => {
      setWsError("WebSocket connection failed");
      setConnected(false);
    };
  }, [projectId, addLine]);

  const disconnect = useCallback(() => {
    wsRef.current?.close();
    wsRef.current = null;
    setConnected(false);
  }, []);

  // Auto-connect when container is running
  useEffect(() => {
    if (containerStatus === "running") {
      connect();
    } else {
      disconnect();
    }
    return () => {
      // Don't disconnect on unmount to keep session alive while switching tabs
    };
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
      if (e.key === "Enter") {
        sendCommand();
      } else if (e.key === "c" && e.ctrlKey) {
        if (wsRef.current?.readyState === WebSocket.OPEN) {
          wsRef.current.send("\x03");
        }
      }
    },
    [sendCommand],
  );

  const clearTerminal = useCallback(() => {
    setLines([]);
  }, []);

  // Container not running — show status panel
  if (containerStatus !== "running") {
    return (
      <div className="flex flex-col h-full items-center justify-center gap-6 p-8 text-center">
        <div className="w-14 h-14 rounded-2xl bg-muted border border-border flex items-center justify-center">
          <Terminal className="h-7 w-7 text-muted-foreground" />
        </div>
        <div>
          <h3 className="text-base font-semibold text-foreground mb-1">Project Terminal</h3>
          <p className="text-sm text-muted-foreground max-w-xs">
            {containerStatus === "starting" || isStarting
              ? "Container is starting up — the terminal will connect automatically."
              : containerStatus === "hibernated"
                ? "Container is hibernated. Wake it to open a terminal."
                : containerStatus === "error"
                  ? "Container is in an error state. Try starting it again."
                  : "Start a container to get a real shell inside your project."}
          </p>
        </div>

        {(containerStatus === "stopped" ||
          containerStatus === "hibernated" ||
          containerStatus === "error") && (
          <Button
            onClick={onStartContainer}
            disabled={isStarting}
            className="gap-2"
          >
            {isStarting ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Power className="h-4 w-4" />
            )}
            {containerStatus === "hibernated" ? "Wake Container" : "Start Container"}
          </Button>
        )}

        {(containerStatus === "starting" || isStarting) && (
          <div className="flex items-center gap-2 text-sm text-primary">
            <Loader2 className="h-4 w-4 animate-spin" />
            <span>Starting up… this may take 20–30 seconds</span>
          </div>
        )}

        <div className="bg-muted/50 border border-border rounded-xl p-4 text-left max-w-sm w-full">
          <div className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider mb-2 flex items-center gap-1">
            <Zap className="h-3 w-3" /> What you get
          </div>
          <ul className="text-xs text-muted-foreground space-y-1.5">
            <li className="flex items-start gap-1.5">
              <span className="text-green-500 shrink-0 mt-0.5">•</span>
              Node.js 20 LTS runtime with npm
            </li>
            <li className="flex items-start gap-1.5">
              <span className="text-green-500 shrink-0 mt-0.5">•</span>
              Real shell — run any command
            </li>
            <li className="flex items-start gap-1.5">
              <span className="text-green-500 shrink-0 mt-0.5">•</span>
              Files stay in sync with the editor
            </li>
            <li className="flex items-start gap-1.5">
              <span className="text-green-500 shrink-0 mt-0.5">•</span>
              Auto-hibernates after 10 min of inactivity
            </li>
          </ul>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full bg-[#0d0f17] font-mono text-sm">
      {/* Toolbar */}
      <div className="shrink-0 flex items-center gap-2 px-3 py-1.5 border-b border-border bg-card">
        <Terminal className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
        <span className="text-[11px] font-medium text-muted-foreground flex-1">
          Project Terminal
          {containerUrl && (
            <span className="ml-2 text-[10px] text-muted-foreground/50 font-normal truncate hidden sm:inline">
              {containerUrl}
            </span>
          )}
        </span>

        <div className="flex items-center gap-1 shrink-0">
          {/* Connection status */}
          <span
            className={cn(
              "flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full border font-medium",
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

          <Button variant="ghost" size="icon" className="h-6 w-6" onClick={clearTerminal} title="Clear terminal">
            <RefreshCw className="h-3 w-3" />
          </Button>

          {connected ? (
            <Button variant="ghost" size="icon" className="h-6 w-6" onClick={disconnect} title="Disconnect">
              <PowerOff className="h-3 w-3 text-destructive" />
            </Button>
          ) : (
            <Button variant="ghost" size="icon" className="h-6 w-6" onClick={connect} title="Reconnect">
              <Power className="h-3 w-3 text-green-400" />
            </Button>
          )}

          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            onClick={onStopContainer}
            title="Hibernate container"
          >
            <PowerOff className="h-3 w-3 text-muted-foreground" />
          </Button>
        </div>
      </div>

      {/* WebSocket error banner */}
      {wsError && (
        <div className="shrink-0 flex items-center gap-2 px-3 py-2 bg-destructive/10 border-b border-destructive/20 text-xs text-destructive">
          <AlertCircle className="h-3.5 w-3.5 shrink-0" />
          {wsError}
          <button
            onClick={() => { setWsError(null); connect(); }}
            className="ml-auto text-[10px] font-semibold border border-destructive/30 px-2 py-0.5 rounded hover:bg-destructive/20 transition-colors"
          >
            Retry
          </button>
        </div>
      )}

      {/* Output area */}
      <div
        ref={outputRef}
        className="flex-1 min-h-0 overflow-y-auto p-3 space-y-0.5 cursor-text"
        onClick={() => inputRef.current?.focus()}
      >
        {lines.length === 0 && (
          <div className="text-muted-foreground/40 text-xs pt-2">
            Terminal ready. Type a command below.
          </div>
        )}
        {lines.map((line) => (
          <div
            key={line.id}
            className={cn(
              "text-[12px] leading-5 whitespace-pre-wrap break-all font-mono",
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

      {/* Input row */}
      <div className="shrink-0 flex items-center gap-2 border-t border-border px-3 py-2 bg-[#0d0f17]">
        <span className="text-cyan-400 text-[12px] shrink-0">$</span>
        <input
          ref={inputRef}
          type="text"
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={!connected}
          placeholder={connected ? "Type a command…" : "Waiting for connection…"}
          className="flex-1 bg-transparent border-0 outline-none text-[12px] font-mono text-zinc-100 placeholder:text-zinc-600 disabled:opacity-40"
          autoFocus
          spellCheck={false}
          autoComplete="off"
          autoCorrect="off"
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
