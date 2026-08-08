import {
  sha256Hex,
  signControlRequest,
  type CapabilityDefinition,
  type CapabilityInvocation,
  type ExecRuntimeRequest,
  type RouteRecord,
  type StripeCapabilityPolicy,
} from "@workspace/tenant-runtime-contracts";
import type { WorkerBindings } from "../src/bindings";
import type {
  CapabilityVault,
  CapabilityVaultInvocationResult,
  ControlAuditRecord,
  ControlCoordinator,
  IdempotencyLookup,
  RuntimeLogEntry,
  StoredHttpResponse,
  StoredRuntime,
  StoredRuntimeArtifact,
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
  readonly routes = new Map<string, RouteRecord>();
  readonly containerBindings = new Map<string, string>();
  readonly artifacts = new Map<string, StoredRuntimeArtifact>();

  async consumeOnce(nonce: string, expiresAtMs: number): Promise<boolean> {
    if (this.nonces.has(nonce)) return false;
    this.nonces.set(nonce, expiresAtMs);
    return true;
  }

  async isConsumedOnce(nonce: string, nowMs: number): Promise<boolean> {
    const expiresAtMs = this.nonces.get(nonce);
    return expiresAtMs !== undefined && expiresAtMs > nowMs;
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

  async putRuntimeIfManifestRevision(
    identity: string,
    expectedManifestRevision: string,
    runtime: StoredRuntime,
  ): Promise<"updated" | "not_found" | "conflict"> {
    const existing = this.runtimes.get(identity);
    if (existing === undefined) return "not_found";
    if (existing.manifest.revision !== expectedManifestRevision) return "conflict";
    this.runtimes.set(identity, structuredClone(runtime));
    return "updated";
  }

  async deleteRuntime(identity: string): Promise<void> {
    this.runtimes.delete(identity);
  }

  async beginArtifact(record: StoredRuntimeArtifact): Promise<"created" | "exists" | "conflict"> {
    const key = `${record.runtimeIdentity}:${record.envelope.sealedArtifactSha256}`;
    const existing = this.artifacts.get(key);
    if (existing !== undefined) {
      return existing.envelope.contentSha256 === record.envelope.contentSha256 &&
        existing.envelope.manifestRevision === record.envelope.manifestRevision
        ? "exists"
        : "conflict";
    }
    this.artifacts.set(key, structuredClone(record));
    return "created";
  }

  async getArtifact(
    identity: string,
    sealedArtifactSha256: string,
  ): Promise<StoredRuntimeArtifact | null> {
    return structuredClone(this.artifacts.get(`${identity}:${sealedArtifactSha256}`) ?? null);
  }

  async recordArtifactChunk(
    identity: string,
    sealedArtifactSha256: string,
    chunkIndex: number,
    chunkSha256: string,
  ): Promise<"recorded" | "replay" | "not_found" | "conflict"> {
    const key = `${identity}:${sealedArtifactSha256}`;
    const artifact = this.artifacts.get(key);
    if (artifact === undefined || artifact.state !== "pending") return "not_found";
    if (chunkIndex < 0 || chunkIndex >= artifact.receivedChunks.length) return "conflict";
    const current = artifact.receivedChunks[chunkIndex];
    if (current !== null) return current === chunkSha256 ? "replay" : "conflict";
    if (artifact.envelope.content.chunks[chunkIndex] !== chunkSha256) return "conflict";
    artifact.receivedChunks[chunkIndex] = chunkSha256;
    return "recorded";
  }

  async commitArtifact(
    identity: string,
    sealedArtifactSha256: string,
  ): Promise<"committed" | "incomplete" | "not_found"> {
    const artifact = this.artifacts.get(`${identity}:${sealedArtifactSha256}`);
    if (artifact === undefined) return "not_found";
    if (artifact.receivedChunks.some((chunk) => chunk === null)) return "incomplete";
    artifact.state = "committed";
    artifact.expiresAtMs = null;
    return "committed";
  }

  async removeArtifact(
    identity: string,
    sealedArtifactSha256: string,
  ): Promise<StoredRuntimeArtifact | null> {
    const key = `${identity}:${sealedArtifactSha256}`;
    const artifact = this.artifacts.get(key);
    if (artifact === undefined) return null;
    this.artifacts.delete(key);
    return structuredClone(artifact);
  }

  async listArtifacts(identity: string): Promise<StoredRuntimeArtifact[]> {
    const records: StoredRuntimeArtifact[] = [];
    for (const artifact of this.artifacts.values()) {
      if (artifact.runtimeIdentity !== identity) continue;
      records.push(structuredClone(artifact));
    }
    return records;
  }

  async bindContainer(containerId: string, identity: string): Promise<void> {
    this.containerBindings.set(containerId, identity);
  }

  async getContainerBinding(containerId: string): Promise<string | null> {
    return this.containerBindings.get(containerId) ?? null;
  }

  async unbindContainer(containerId: string, expectedIdentity: string): Promise<boolean> {
    if (this.containerBindings.get(containerId) !== expectedIdentity) return false;
    this.containerBindings.delete(containerId);
    return true;
  }

  async getRoute(hostname: string): Promise<RouteRecord | null> {
    const route = this.routes.get(hostname);
    return route === undefined ? null : structuredClone(route);
  }

  async activateRoute(
    route: RouteRecord,
    expectedPreviousManifestRevision: string | null,
  ): Promise<"activated" | "conflict"> {
    const current = this.routes.get(route.hostname);
    if ((current?.manifestRevision ?? null) !== expectedPreviousManifestRevision) return "conflict";
    this.routes.set(route.hostname, structuredClone(route));
    return "activated";
  }

  async deactivateRoute(
    hostname: string,
    expectedManifestRevision: string,
    expectedSandboxIdentity: string,
  ): Promise<"deactivated" | "not_found" | "conflict"> {
    const current = this.routes.get(hostname);
    if (current === undefined) return "not_found";
    if (
      current.manifestRevision !== expectedManifestRevision ||
      current.sandboxIdentity !== expectedSandboxIdentity
    ) {
      return "conflict";
    }
    this.routes.delete(hostname);
    return "deactivated";
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
  materializations = 0;
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

  async materialize(
    _runtime: StoredRuntime,
    artifact: StoredRuntimeArtifact,
  ): Promise<{ filesWritten: number }> {
    this.materializations += 1;
    return { filesWritten: artifact.envelope.content.files.length };
  }
}

export class MemoryR2Bucket {
  readonly objects = new Map<string, Uint8Array>();

  async put(key: string, value: ArrayBuffer | ArrayBufferView | string): Promise<unknown> {
    const bytes =
      typeof value === "string"
        ? new TextEncoder().encode(value)
        : value instanceof ArrayBuffer
          ? new Uint8Array(value)
          : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    this.objects.set(key, new Uint8Array(bytes));
    return {};
  }

  async get(
    key: string,
    options?: { range?: { offset: number; length: number } },
  ): Promise<{
    body: ReadableStream<Uint8Array>;
    arrayBuffer(): Promise<ArrayBuffer>;
  } | null> {
    const stored = this.objects.get(key);
    if (stored === undefined) return null;
    const offset = options?.range?.offset ?? 0;
    const length = options?.range?.length ?? stored.byteLength - offset;
    const bytes = stored.slice(offset, offset + length);
    return {
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(bytes);
          controller.close();
        },
      }),
      async arrayBuffer() {
        return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      },
    };
  }

  async delete(keys: string | string[]): Promise<void> {
    for (const key of typeof keys === "string" ? [keys] : keys) this.objects.delete(key);
  }
}

export class MemoryCapabilityVault implements CapabilityVault {
  readonly records = new Map<number, { revision: string; definition: CapabilityDefinition }>();
  readonly databaseRecords = new Map<
    number,
    { revision: string; definition: CapabilityDefinition; credential: string }
  >();
  readonly stripeRecords = new Map<
    number,
    {
      revision: string;
      definition: CapabilityDefinition;
      policy: StripeCapabilityPolicy;
      credential: string;
    }
  >();

  async provisionEcho(input: {
    projectId: number;
    revision: string;
    definition: CapabilityDefinition;
  }): Promise<{ state: "provisioned"; keyId: string }> {
    this.records.set(input.projectId, {
      revision: input.revision,
      definition: structuredClone(input.definition),
    });
    return { state: "provisioned", keyId: "v1" };
  }

  async revokeEcho(input: {
    projectId: number;
    expectedRevision: string;
  }): Promise<"revoked" | "not_found" | "conflict"> {
    const record = this.records.get(input.projectId);
    if (record === undefined) return "not_found";
    if (record.revision !== input.expectedRevision) return "conflict";
    this.records.delete(input.projectId);
    return "revoked";
  }

  async invokeEcho(input: {
    projectId: number;
    invocation: CapabilityInvocation;
  }): Promise<CapabilityVaultInvocationResult> {
    const record = this.records.get(input.projectId);
    if (record === undefined) return { state: "not_found" };
    if (
      input.invocation.requestedProjectId !== undefined &&
      input.invocation.requestedProjectId !== input.projectId
    ) {
      return { state: "tenant_mismatch" };
    }
    if (
      input.invocation.capability.provider !== record.definition.provider ||
      input.invocation.capability.name !== record.definition.name ||
      input.invocation.action !== "invoke"
    ) {
      return { state: "policy_rejected" };
    }
    return {
      state: "success",
      response: {
        ok: true,
        capability: input.invocation.capability,
        requestId: input.invocation.requestId,
        runtimeIdentity: input.invocation.caller.runtimeIdentity,
        actedBy: "capability-vault",
        proof: "a".repeat(64),
        echo: input.invocation.input,
      },
    };
  }

  async provisionDatabase(input: {
    projectId: number;
    revision: string;
    definition: CapabilityDefinition;
    credential: { kind: "neon-connection-string"; value: string };
  }): Promise<{ state: "provisioned"; keyId: string }> {
    this.databaseRecords.set(input.projectId, {
      revision: input.revision,
      definition: structuredClone(input.definition),
      credential: input.credential.value,
    });
    return { state: "provisioned", keyId: "v1" };
  }

  async revokeDatabase(input: {
    projectId: number;
    expectedRevision: string;
  }): Promise<"revoked" | "not_found" | "conflict"> {
    const record = this.databaseRecords.get(input.projectId);
    if (record === undefined) return "not_found";
    if (record.revision !== input.expectedRevision) return "conflict";
    this.databaseRecords.delete(input.projectId);
    return "revoked";
  }

  async invokeDatabase(input: {
    projectId: number;
    invocation: CapabilityInvocation;
  }): Promise<CapabilityVaultInvocationResult> {
    const record = this.databaseRecords.get(input.projectId);
    if (record === undefined) return { state: "not_found" };
    if (
      input.invocation.requestedProjectId !== undefined &&
      input.invocation.requestedProjectId !== input.projectId
    ) {
      return { state: "tenant_mismatch" };
    }
    if (
      input.invocation.capability.provider !== record.definition.provider ||
      input.invocation.capability.name !== record.definition.name ||
      input.invocation.action !== "query"
    ) {
      return { state: "policy_rejected" };
    }
    const statement =
      input.invocation.input.kind === "atomic-batch"
        ? {
            kind: "atomic-batch" as const,
            results: (input.invocation.input.statements as unknown[]).map(() => ({
              command: "SELECT",
              rowCount: 1,
              rows: [{ value: "memory-database" }],
            })),
          }
        : {
            kind: "statement" as const,
            result: {
              command: "SELECT",
              rowCount: 1,
              rows: [{ value: "memory-database" }],
            },
          };
    return {
      state: "success",
      response: {
        ok: true,
        capability: input.invocation.capability,
        requestId: input.invocation.requestId,
        runtimeIdentity: input.invocation.caller.runtimeIdentity,
        actedBy: "database-broker",
        result: statement,
      },
    };
  }

  async provisionStripe(input: {
    projectId: number;
    revision: string;
    definition: CapabilityDefinition;
    policy: StripeCapabilityPolicy;
    credential: { kind: "stripe-test-secret-key"; value: string };
  }): Promise<{ state: "provisioned"; keyId: string }> {
    this.stripeRecords.set(input.projectId, {
      revision: input.revision,
      definition: structuredClone(input.definition),
      policy: structuredClone(input.policy),
      credential: input.credential.value,
    });
    return { state: "provisioned", keyId: "v1" };
  }

  async revokeStripe(input: {
    projectId: number;
    expectedRevision: string;
  }): Promise<"revoked" | "not_found" | "conflict"> {
    const record = this.stripeRecords.get(input.projectId);
    if (record === undefined) return "not_found";
    if (record.revision !== input.expectedRevision) return "conflict";
    this.stripeRecords.delete(input.projectId);
    return "revoked";
  }

  async invokeStripe(input: {
    projectId: number;
    invocation: CapabilityInvocation;
  }): Promise<CapabilityVaultInvocationResult> {
    const record = this.stripeRecords.get(input.projectId);
    if (record === undefined) return { state: "not_found" };
    if (
      input.invocation.requestedProjectId !== undefined &&
      input.invocation.requestedProjectId !== input.projectId
    ) {
      return { state: "tenant_mismatch" };
    }
    if (
      input.invocation.capability.provider !== record.definition.provider ||
      input.invocation.capability.name !== record.definition.name ||
      input.invocation.action !== "execute"
    ) {
      return { state: "policy_rejected" };
    }
    const operation = input.invocation.input.kind;
    if (operation !== "create-payment-intent" && operation !== "retrieve-payment-intent") {
      return {
        state: "stripe_error",
        status: 400,
        code: "stripe_invalid_request",
        retryable: false,
      };
    }
    return {
      state: "success",
      response: {
        ok: true,
        capability: input.invocation.capability,
        requestId: input.invocation.requestId,
        runtimeIdentity: input.invocation.caller.runtimeIdentity,
        actedBy: "stripe-broker",
        operation,
        idempotentReplay: false,
        paymentIntent: {
          id: "pi_memory123",
          status: "requires_payment_method",
          amount: 1_099,
          amountReceived: 0,
          currency: "usd",
          created: 1_785_859_200,
          livemode: false,
        },
      },
    };
  }
}

export function fakeEnv(): WorkerBindings {
  const artifactBucket = new MemoryR2Bucket();
  return {
    CF_VERSION_METADATA: {
      id: "worker-version-test-1",
      tag: "",
      timestamp: new Date(TEST_NOW_MS).toISOString(),
    },
    CLOUDFLARE_RUNTIME_CONTROL_TOKEN: TEST_SECRET,
    CLOUDFLARE_CAPABILITY_VAULT_KEK_V1: "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY",
    CLOUDFLARE_RUNTIME_DEPLOYMENT_NAMESPACE: "staging",
    CLOUDFLARE_RUNTIME_PREVIEW_PUBLIC_KEY: "test-public-key",
    NABUFLOW_RUNTIME_SLEEP_AFTER: "10m",
    NABUFLOW_CAPABILITY_VAULT_ACTIVE_KEY_ID: "v1",
    NABUFLOW_RUNTIME_ARTIFACTS: artifactBucket as unknown as R2Bucket,
    NABUFLOW_SANDBOX: {
      idFromName(identity: string) {
        return { toString: () => `container:${identity}` };
      },
    },
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

export async function signedRawRequest(input: {
  path: string;
  method: string;
  body: Uint8Array;
  timestamp?: number;
  nonce: string;
  idempotencyKey: string;
  secret?: string;
}): Promise<Request> {
  const timestamp = String(input.timestamp ?? TEST_NOW_MS);
  const bodySha256 = await sha256Hex(input.body);
  const signature = await signControlRequest(input.secret ?? TEST_SECRET, {
    method: input.method,
    pathAndQuery: input.path,
    timestamp,
    nonce: input.nonce,
    bodySha256,
    idempotencyKey: input.idempotencyKey,
  });
  return new Request(`https://runtime.example${input.path}`, {
    method: input.method,
    body: input.body.slice().buffer as ArrayBuffer,
    headers: {
      "content-type": "application/octet-stream",
      "x-nabuflow-timestamp": timestamp,
      "x-nabuflow-nonce": input.nonce,
      "x-nabuflow-body-sha256": bodySha256,
      "x-nabuflow-signature": signature,
      "idempotency-key": input.idempotencyKey,
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
