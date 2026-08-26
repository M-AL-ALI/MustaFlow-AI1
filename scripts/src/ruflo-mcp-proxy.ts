import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  RUFLO_ALLOWED_TOOLS,
  RUFLO_MAX_MESSAGE_BYTES,
  RUFLO_MCP_POLICY_VERSION,
  RUFLO_PINNED_FILES,
  RUFLO_PINNED_VERSION,
  authorizeRufloClientRequest,
  buildSanitizedRufloEnvironment,
  filterRufloServerResponse,
  findRepositoryRoot,
  parseRufloVersion,
  resolveRufloSafePaths,
} from "./ruflo-mcp-policy";

const repositoryRoot = findRepositoryRoot(process.cwd());
const safePaths = resolveRufloSafePaths(repositoryRoot);
const childEnvironment = buildSanitizedRufloEnvironment(safePaths);
childEnvironment.GIT_DIR = execFileSync(
  "git",
  ["-C", repositoryRoot, "rev-parse", "--absolute-git-dir"],
  { encoding: "utf8", windowsHide: true },
).trim();
childEnvironment.GIT_WORK_TREE = repositoryRoot;

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function resolveRufloEntry(): string {
  const entry = join(safePaths.toolRoot, "node_modules/ruflo/bin/ruflo.js");
  if (!existsSync(entry)) throw new Error("ruflo_a_drive_install_unavailable");
  for (const [relativePath, expectedHash] of Object.entries(RUFLO_PINNED_FILES)) {
    const actualHash = sha256(join(safePaths.toolRoot, ...relativePath.split("/")));
    if (actualHash !== expectedHash) throw new Error("ruflo_install_hash_mismatch");
  }
  return entry;
}

const rufloEntry = resolveRufloEntry();

function runVersionCheck(): Promise<string> {
  return new Promise((resolve, reject) => {
    mkdirSync(safePaths.runtimeRoot, { recursive: true });
    const child = spawn(process.execPath, [rufloEntry, "--version"], {
      cwd: safePaths.runtimeRoot,
      env: childEnvironment,
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
    let output = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("ruflo_version_check_timeout"));
    }, 10_000);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      output += chunk;
      if (output.length > 256) {
        child.kill();
        reject(new Error("ruflo_version_output_unbounded"));
      }
    });
    child.once("error", () => {
      clearTimeout(timer);
      reject(new Error("ruflo_executable_unavailable"));
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error("ruflo_version_check_failed"));
        return;
      }
      const version = parseRufloVersion(output);
      if (version !== RUFLO_PINNED_VERSION) {
        reject(new Error("ruflo_version_mismatch"));
        return;
      }
      resolve(version);
    });
  });
}

function emit(message: unknown): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function emitProxyError(code: string): void {
  process.stderr.write(`[nabuflow-ruflo] ${code}\n`);
}

function makeLineConsumer(
  onMessage: (message: unknown) => void,
  onInvalid: () => void,
): (chunk: Buffer | string) => void {
  let buffer = "";
  return (chunk) => {
    buffer += chunk.toString();
    if (Buffer.byteLength(buffer, "utf8") > RUFLO_MAX_MESSAGE_BYTES) {
      buffer = "";
      onInvalid();
      return;
    }
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        onMessage(JSON.parse(line));
      } catch {
        onInvalid();
      }
    }
  };
}

async function main(): Promise<void> {
  const version = await runVersionCheck();
  if (process.argv.includes("--self-check")) {
    process.stdout.write(
      `${JSON.stringify({
        ok: true,
        policy: RUFLO_MCP_POLICY_VERSION,
        version,
        repositoryRoot: safePaths.repositoryRoot,
        runtimeRoot: safePaths.runtimeRoot,
        toolRoot: safePaths.toolRoot,
        temp: safePaths.temp,
        daemonAutostart: false,
        toolCount: RUFLO_ALLOWED_TOOLS.length,
        tools: RUFLO_ALLOWED_TOOLS,
        forwardedEnvironmentKeys: Object.keys(childEnvironment).sort(),
      })}\n`,
    );
    return;
  }

  for (const directory of [
    safePaths.runtimeRoot,
    safePaths.home,
    safePaths.appData,
    safePaths.localAppData,
    safePaths.cache,
    safePaths.config,
    safePaths.data,
    safePaths.temp,
  ]) {
    mkdirSync(directory, { recursive: true });
  }

  const child = spawn(
    process.execPath,
    [rufloEntry, "mcp", "start", "--tools", RUFLO_ALLOWED_TOOLS.join(",")],
    {
      cwd: safePaths.runtimeRoot,
      env: childEnvironment,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    },
  );

  let childStderrBytes = 0;
  child.stderr.on("data", (chunk: Buffer) => {
    childStderrBytes += chunk.byteLength;
  });

  process.stdin.on(
    "data",
    makeLineConsumer(
      (message) => {
        const decision = authorizeRufloClientRequest(message);
        if (!decision.allowed) {
          emit(decision.response);
          return;
        }
        child.stdin.write(`${JSON.stringify(decision.message)}\n`);
      },
      () => emit({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }),
    ),
  );

  child.stdout.on(
    "data",
    makeLineConsumer(
      (message) => emit(filterRufloServerResponse(message)),
      () =>
        emit({
          jsonrpc: "2.0",
          id: null,
          error: { code: -32603, message: "Ruflo returned an invalid MCP response" },
        }),
    ),
  );

  process.stdin.once("end", () => child.stdin.end());
  child.once("error", () => {
    emitProxyError("ruflo_child_start_failed");
    process.exitCode = 1;
  });
  child.once("exit", (code) => {
    if (code !== 0) {
      emitProxyError(`ruflo_child_exit code=${code ?? "signal"} stderr_bytes=${childStderrBytes}`);
    }
    process.exitCode = code ?? 1;
  });

  const stop = () => {
    child.stdin.end();
    child.kill();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

main().catch((error: unknown) => {
  emitProxyError(error instanceof Error ? error.message : "ruflo_proxy_failed");
  process.exitCode = 1;
});
