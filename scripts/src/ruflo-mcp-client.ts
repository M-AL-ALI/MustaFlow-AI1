import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { resolve } from "node:path";
import {
  RUFLO_MAX_MESSAGE_BYTES,
  buildSanitizedRufloEnvironment,
  findRepositoryRoot,
  resolveRufloSafePaths,
} from "./ruflo-mcp-policy";

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

interface JsonRpcEnvelope {
  id?: unknown;
  result?: unknown;
  error?: { code?: unknown; message?: unknown };
}

export class RufloMcpError extends Error {
  constructor(
    readonly code: number | null,
    message: string,
  ) {
    super(message);
    this.name = "RufloMcpError";
  }
}

export interface RufloToolTransport {
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
}

export class RufloMcpProcessClient implements RufloToolTransport {
  private child: ChildProcessWithoutNullStreams | null = null;
  private sequence = 0;
  private stdoutBuffer = "";
  private readonly pending = new Map<number, PendingRequest>();
  private stderrBytes = 0;

  constructor(
    private readonly repositoryRoot = findRepositoryRoot(process.cwd()),
    private readonly timeoutMs = 45_000,
  ) {}

  async start(): Promise<void> {
    if (this.child) throw new Error("ruflo_client_already_started");
    const safePaths = resolveRufloSafePaths(this.repositoryRoot);
    const environment = buildSanitizedRufloEnvironment(safePaths);
    const proxyPath = resolve(this.repositoryRoot, "scripts/src/ruflo-mcp-proxy.ts");
    const tsxLoader = import.meta.resolve("tsx");
    const child = spawn(process.execPath, ["--import", tsxLoader, proxyPath], {
      cwd: this.repositoryRoot,
      env: environment,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.child = child;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.consumeStdout(chunk));
    child.stderr.on("data", (chunk: Buffer) => {
      this.stderrBytes += chunk.byteLength;
    });
    child.once("error", () => this.rejectAll("ruflo_proxy_start_failed"));
    child.once("exit", (code) => {
      if (code !== 0 && this.pending.size > 0) {
        this.rejectAll(`ruflo_proxy_exit code=${code ?? "signal"}`);
      }
      this.child = null;
    });

    await this.request(
      "initialize",
      {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "nabuflow-ruflo-pilot", version: "1.0.0" },
      },
      90_000,
    );
    this.notify("notifications/initialized", {});
  }

  async listTools(): Promise<string[]> {
    const result = (await this.request("tools/list", {})) as {
      tools?: { name?: unknown }[];
    };
    if (!Array.isArray(result.tools)) throw new Error("ruflo_tool_list_invalid");
    return result.tools
      .map((tool) => tool.name)
      .filter((name): name is string => typeof name === "string");
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    const result = (await this.request("tools/call", { name, arguments: args })) as {
      content?: { type?: unknown; text?: unknown }[];
    };
    const text = result.content?.find((entry) => entry.type === "text")?.text;
    if (typeof text !== "string" || Buffer.byteLength(text, "utf8") > RUFLO_MAX_MESSAGE_BYTES) {
      throw new Error("ruflo_tool_result_invalid");
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new Error("ruflo_tool_result_not_json");
    }
  }

  async expectDeniedTool(name: string, args: Record<string, unknown>): Promise<number | null> {
    try {
      await this.request("tools/call", { name, arguments: args });
    } catch (error) {
      if (error instanceof RufloMcpError) return error.code;
      throw error;
    }
    throw new Error("ruflo_unauthorized_tool_was_allowed");
  }

  async close(): Promise<{ stderrBytes: number }> {
    const child = this.child;
    if (child) {
      child.stdin.end();
      await Promise.race([
        new Promise<void>((resolveExit) => child.once("exit", () => resolveExit())),
        new Promise<void>((resolveTimeout) =>
          setTimeout(() => {
            child.kill();
            resolveTimeout();
          }, 2_000),
        ),
      ]);
      this.child = null;
    }
    this.rejectAll("ruflo_client_closed");
    return { stderrBytes: this.stderrBytes };
  }

  private request(method: string, params: Record<string, unknown>, timeoutMs = this.timeoutMs) {
    const child = this.child;
    if (!child) return Promise.reject(new Error("ruflo_client_not_started"));
    const id = ++this.sequence;
    return new Promise<unknown>((resolveRequest, rejectRequest) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectRequest(new Error(`ruflo_request_timeout method=${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolveRequest, reject: rejectRequest, timer });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  private notify(method: string, params: Record<string, unknown>): void {
    this.child?.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  private consumeStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    if (Buffer.byteLength(this.stdoutBuffer, "utf8") > RUFLO_MAX_MESSAGE_BYTES) {
      this.stdoutBuffer = "";
      this.rejectAll("ruflo_stdout_unbounded");
      return;
    }
    const lines = this.stdoutBuffer.split("\n");
    this.stdoutBuffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      let message: JsonRpcEnvelope;
      try {
        message = JSON.parse(line) as JsonRpcEnvelope;
      } catch {
        this.rejectAll("ruflo_response_parse_failed");
        continue;
      }
      if (typeof message.id !== "number") continue;
      const pending = this.pending.get(message.id);
      if (!pending) continue;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(
          new RufloMcpError(
            typeof message.error.code === "number" ? message.error.code : null,
            typeof message.error.message === "string" ? message.error.message : "Ruflo MCP error",
          ),
        );
      } else {
        pending.resolve(message.result);
      }
    }
  }

  private rejectAll(code: string): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(code));
    }
    this.pending.clear();
  }
}
