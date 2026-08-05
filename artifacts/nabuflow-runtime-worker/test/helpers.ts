import {
  sha256Hex,
  signControlRequest,
  type ExecRuntimeRequest,
} from "@workspace/tenant-runtime-contracts";
import type { WorkerBindings } from "../src/bindings";
import type {
  ControlAuditRecord,
  ControlCoordinator,
  IdempotencyLookup,
  RuntimeLogEntry,
  StoredHttpResponse,
  StoredRuntime,
} from "../src/model";
import type {
  BackendExecResult,
  BackendStartResult,
  BackendStatusResult,
  RuntimeBackend,
} from "../src/runtime-backend";

export const TEST_SECRET = "0123456789abcdef0123456789abcdef";
export const TEST_NOW_MS = 1_785_859_200_000;

export class MemoryCoordinator implements ControlCoordinator {
  readonly nonces = new Map<string, number>();
  readonly idempotency = new Map<
    string,
    { fingerprint: string; pending: boolean; response?: StoredHttpResponse }
  >();
  readonly audits: ControlAuditRecord[] = [];
  readonly runtimes = new Map<string, StoredRuntime>();

  async consumeOnce(nonce: string, expiresAtMs: number): Promise<boolean> {
    if (this.nonces.has(nonce)) return false;
    this.nonces.set(nonce, expiresAtMs);
    return true;
  }

  async beginIdempotency(
    key: string,
    fingerprint: string,
    _nowMs: number,
  ): Promise<IdempotencyLookup> {
    const existing = this.idempotency.get(key);
    if (existing === undefined) {
      this.idempotency.set(key, { fingerprint, pending: true });
      return { state: "new" };
    }
    if (existing.fingerprint !== fingerprint) return { state: "conflict" };
    if (existing.pending || existing.response === undefined) return { state: "pending" };
    return { state: "replay", response: structuredClone(existing.response) };
  }

  async completeIdempotency(
    key: string,
    fingerprint: string,
    response: StoredHttpResponse,
  ): Promise<void> {
    this.idempotency.set(key, {
      fingerprint,
      pending: false,
      response: structuredClone(response),
    });
  }

  async abandonIdempotency(key: string, fingerprint: string): Promise<void> {
    if (this.idempotency.get(key)?.fingerprint === fingerprint) this.idempotency.delete(key);
  }

  async recordAudit(record: ControlAuditRecord): Promise<void> {
    this.audits.push(structuredClone(record));
  }

  async getRuntime(identity: string): Promise<StoredRuntime | null> {
    const runtime = this.runtimes.get(identity);
    return runtime === undefined ? null : structuredClone(runtime);
  }

  async putRuntime(identity: string, runtime: StoredRuntime): Promise<void> {
    this.runtimes.set(identity, structuredClone(runtime));
  }

  async deleteRuntime(identity: string): Promise<void> {
    this.runtimes.delete(identity);
  }

  async appendSystemLog(identity: string, message: string): Promise<void> {
    const runtime = this.runtimes.get(identity);
    if (runtime === undefined) return;
    runtime.nextLogSequence += 1;
    runtime.logs.push({
      cursor: `log-${runtime.nextLogSequence.toString().padStart(10, "0")}`,
      timestamp: new Date(TEST_NOW_MS).toISOString(),
      level: "system",
      message,
    });
  }

  async mergeProcessLogs(identity: string, stdout: string, stderr: string): Promise<void> {
    const runtime = this.runtimes.get(identity);
    if (runtime === undefined) return;
    const append = (level: RuntimeLogEntry["level"], message: string) => {
      if (!message) return;
      runtime.nextLogSequence += 1;
      runtime.logs.push({
        cursor: `log-${runtime.nextLogSequence.toString().padStart(10, "0")}`,
        timestamp: new Date(TEST_NOW_MS).toISOString(),
        level,
        message,
      });
    };
    append("stdout", stdout.slice(runtime.stdoutLength));
    append("stderr", stderr.slice(runtime.stderrLength));
    runtime.stdoutLength = stdout.length;
    runtime.stderrLength = stderr.length;
  }

  async listRuntimeLogs(
    identity: string,
    cursor: string | undefined,
    limit: number,
  ): Promise<{ entries: RuntimeLogEntry[]; nextCursor: string | null }> {
    const runtime = this.runtimes.get(identity);
    if (runtime === undefined) return { entries: [], nextCursor: null };
    const after = cursor === undefined ? 0 : Number(cursor.slice(4));
    const entries = runtime.logs
      .filter((entry) => Number(entry.cursor.slice(4)) > after)
      .slice(0, limit);
    return {
      entries: structuredClone(entries),
      nextCursor: entries.at(-1)?.cursor ?? cursor ?? null,
    };
  }
}

export class MockBackend implements RuntimeBackend {
  starts = 0;
  stops = 0;
  destroys = 0;
  execs = 0;
  processLogs = { stdout: "server ready\n", stderr: "" };

  async start(_runtime: StoredRuntime): Promise<BackendStartResult> {
    this.starts += 1;
    return { processId: "tenant-service", readyAt: new Date(TEST_NOW_MS).toISOString() };
  }

  async stop(_runtime: StoredRuntime): Promise<void> {
    this.stops += 1;
  }

  async destroy(_runtime: StoredRuntime): Promise<void> {
    this.destroys += 1;
  }

  async status(_runtime: StoredRuntime): Promise<BackendStatusResult> {
    return { running: true, lastError: null };
  }

  async exec(_runtime: StoredRuntime, _request: ExecRuntimeRequest): Promise<BackendExecResult> {
    this.execs += 1;
    return {
      ok: true,
      stdout: "nabuflow-control-plane-ok\n",
      stderr: "",
      exitCode: 0,
      timedOut: false,
    };
  }

  async logs(_runtime: StoredRuntime): Promise<{ stdout: string; stderr: string }> {
    return this.processLogs;
  }
}

export function fakeEnv(): WorkerBindings {
  return {
    CF_VERSION_METADATA: {
      id: "worker-version-test-1",
      tag: "",
      timestamp: new Date(TEST_NOW_MS).toISOString(),
    },
    CLOUDFLARE_RUNTIME_CONTROL_TOKEN: TEST_SECRET,
    CLOUDFLARE_RUNTIME_DEPLOYMENT_NAMESPACE: "staging",
    NABUFLOW_RUNTIME_SLEEP_AFTER: "10m",
  } as WorkerBindings;
}

export async function signedRequest(input: {
  path: string;
  method?: string;
  body?: unknown;
  timestamp?: number;
  nonce: string;
  idempotencyKey?: string;
  secret?: string;
}): Promise<Request> {
  const method = input.method ?? "GET";
  const body = input.body === undefined ? "" : JSON.stringify(input.body);
  const timestamp = String(input.timestamp ?? TEST_NOW_MS);
  const bodySha256 = await sha256Hex(body);
  const idempotencyKey = input.idempotencyKey ?? "";
  const fields = {
    method,
    pathAndQuery: input.path,
    timestamp,
    nonce: input.nonce,
    bodySha256,
    idempotencyKey,
  };
  const signature = await signControlRequest(input.secret ?? TEST_SECRET, fields);
  return new Request(`https://runtime.example${input.path}`, {
    method,
    body: body || undefined,
    headers: {
      ...(body ? { "content-type": "application/json" } : {}),
      "x-nabuflow-timestamp": timestamp,
      "x-nabuflow-nonce": input.nonce,
      "x-nabuflow-body-sha256": bodySha256,
      "x-nabuflow-signature": signature,
      ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
    },
  });
}

export function ensureBody() {
  return {
    locator: { projectId: 42, role: "preview" as const, slot: "primary" as const },
    expectedDeploymentVersion: "worker-version-test-1",
    manifest: {
      revision: "manifest-1",
      runtime: "node",
      buildCommand: ["node", "--version"],
      startCommand: ["node", "server.mjs"],
      servicePort: 8080,
      healthPath: "/health",
      resourceProfile: "dev",
      public: false,
    },
  };
}
