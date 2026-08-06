import { DurableObject } from "cloudflare:workers";
import { sha256Hex } from "@workspace/tenant-runtime-contracts";
import type { WorkerBindings } from "./bindings";
import type {
  ControlAuditRecord,
  ControlCoordinator,
  IdempotencyLookup,
  RuntimeLogEntry,
  StoredHttpResponse,
  StoredRuntime,
} from "./model";

const IDEMPOTENCY_PENDING_TTL_MS = 10 * 60 * 1_000;
const IDEMPOTENCY_COMPLETED_TTL_MS = 24 * 60 * 60 * 1_000;
const MAX_AUDIT_RECORDS = 1_000;
const MAX_RUNTIME_LOGS = 1_000;
const MAX_LOG_MESSAGE_LENGTH = 100_000;

interface StoredIdempotencyRecord {
  fingerprint: string;
  state: "pending" | "completed";
  expiresAtMs: number;
  response?: StoredHttpResponse;
}

function runtimeKey(identity: string): string {
  return `runtime:${identity}`;
}

function formatCursor(sequence: number): string {
  return `log-${sequence.toString().padStart(10, "0")}`;
}

function parseCursor(cursor: string | undefined): number {
  if (cursor === undefined) return 0;
  const match = /^log-([0-9]{10})$/.exec(cursor);
  if (!match) throw new Error("Malformed log cursor");
  return Number(match[1]);
}

function splitLogDelta(message: string): string[] {
  if (!message) return [];
  const chunks: string[] = [];
  for (let offset = 0; offset < message.length; offset += MAX_LOG_MESSAGE_LENGTH) {
    chunks.push(message.slice(offset, offset + MAX_LOG_MESSAGE_LENGTH));
  }
  return chunks;
}

export class ControlDurableObject
  extends DurableObject<WorkerBindings>
  implements ControlCoordinator
{
  async consumeOnce(nonce: string, expiresAtMs: number): Promise<boolean> {
    const key = `nonce:${await sha256Hex(nonce)}`;
    const consumed = await this.ctx.storage.transaction(async (transaction) => {
      const existing = await transaction.get<number>(key);
      const nowMs = Date.now();
      if (existing !== undefined && existing > nowMs) return false;
      await transaction.put(key, expiresAtMs);
      return true;
    });
    if (consumed) await this.scheduleCleanup(this.ctx.storage, expiresAtMs);
    return consumed;
  }

  async isConsumedOnce(nonce: string, nowMs: number): Promise<boolean> {
    const expiresAtMs = await this.ctx.storage.get<number>(`nonce:${await sha256Hex(nonce)}`);
    return expiresAtMs !== undefined && expiresAtMs > nowMs;
  }

  async beginIdempotency(
    key: string,
    fingerprint: string,
    nowMs: number,
  ): Promise<IdempotencyLookup> {
    const storageKey = `idempotency:${await sha256Hex(key)}`;
    const result: IdempotencyLookup = await this.ctx.storage.transaction(async (transaction) => {
      const existing = await transaction.get<StoredIdempotencyRecord>(storageKey);
      if (existing !== undefined && existing.expiresAtMs > nowMs) {
        if (existing.fingerprint !== fingerprint) return { state: "conflict" } as const;
        if (existing.state === "pending") return { state: "pending" } as const;
        if (existing.response === undefined) return { state: "pending" } as const;
        return { state: "replay", response: existing.response } as const;
      }

      const expiresAtMs = nowMs + IDEMPOTENCY_PENDING_TTL_MS;
      await transaction.put(storageKey, {
        fingerprint,
        state: "pending",
        expiresAtMs,
      } satisfies StoredIdempotencyRecord);
      return { state: "new" } as const;
    });
    if (result.state === "new") {
      await this.scheduleCleanup(this.ctx.storage, nowMs + IDEMPOTENCY_PENDING_TTL_MS);
    }
    return result;
  }

  async completeIdempotency(
    key: string,
    fingerprint: string,
    response: StoredHttpResponse,
    nowMs: number,
  ): Promise<void> {
    const storageKey = `idempotency:${await sha256Hex(key)}`;
    const expiresAtMs = nowMs + IDEMPOTENCY_COMPLETED_TTL_MS;
    await this.ctx.storage.transaction(async (transaction) => {
      const existing = await transaction.get<StoredIdempotencyRecord>(storageKey);
      if (existing === undefined || existing.fingerprint !== fingerprint) {
        throw new Error("Idempotency reservation no longer belongs to this request");
      }
      await transaction.put(storageKey, {
        fingerprint,
        state: "completed",
        expiresAtMs,
        response,
      } satisfies StoredIdempotencyRecord);
    });
    await this.scheduleCleanup(this.ctx.storage, expiresAtMs);
  }

  async abandonIdempotency(key: string, fingerprint: string): Promise<void> {
    const storageKey = `idempotency:${await sha256Hex(key)}`;
    await this.ctx.storage.transaction(async (transaction) => {
      const existing = await transaction.get<StoredIdempotencyRecord>(storageKey);
      if (existing?.state === "pending" && existing.fingerprint === fingerprint) {
        await transaction.delete(storageKey);
      }
    });
  }

  async recordAudit(record: ControlAuditRecord): Promise<void> {
    const sequence = (await this.ctx.storage.get<number>("audit:sequence")) ?? 0;
    const nextSequence = sequence + 1;
    await this.ctx.storage.put({
      "audit:sequence": nextSequence,
      [`audit:${nextSequence.toString().padStart(12, "0")}`]: record,
    });
    const oldest = nextSequence - MAX_AUDIT_RECORDS;
    if (oldest > 0) {
      await this.ctx.storage.delete(`audit:${oldest.toString().padStart(12, "0")}`);
    }
  }

  async getRuntime(identity: string): Promise<StoredRuntime | null> {
    return (await this.ctx.storage.get<StoredRuntime>(runtimeKey(identity))) ?? null;
  }

  async putRuntime(identity: string, runtime: StoredRuntime): Promise<void> {
    await this.ctx.storage.put(runtimeKey(identity), runtime);
  }

  async deleteRuntime(identity: string): Promise<void> {
    await this.ctx.storage.delete(runtimeKey(identity));
  }

  async appendSystemLog(identity: string, message: string): Promise<void> {
    await this.ctx.storage.transaction(async (transaction) => {
      const key = runtimeKey(identity);
      const runtime = await transaction.get<StoredRuntime>(key);
      if (runtime === undefined) return;
      this.appendLogEntries(runtime, "system", splitLogDelta(message));
      await transaction.put(key, runtime);
    });
  }

  async mergeProcessLogs(identity: string, stdout: string, stderr: string): Promise<void> {
    await this.ctx.storage.transaction(async (transaction) => {
      const key = runtimeKey(identity);
      const runtime = await transaction.get<StoredRuntime>(key);
      if (runtime === undefined) return;

      const stdoutDelta = stdout.slice(runtime.stdoutLength);
      const stderrDelta = stderr.slice(runtime.stderrLength);
      runtime.stdoutLength = stdout.length;
      runtime.stderrLength = stderr.length;
      this.appendLogEntries(runtime, "stdout", splitLogDelta(stdoutDelta));
      this.appendLogEntries(runtime, "stderr", splitLogDelta(stderrDelta));
      await transaction.put(key, runtime);
    });
  }

  async listRuntimeLogs(
    identity: string,
    cursor: string | undefined,
    limit: number,
  ): Promise<{ entries: RuntimeLogEntry[]; nextCursor: string | null }> {
    const runtime = await this.getRuntime(identity);
    if (runtime === null) return { entries: [], nextCursor: null };
    const afterSequence = parseCursor(cursor);
    const entries = runtime.logs
      .filter((entry) => Number(entry.cursor.slice(4)) > afterSequence)
      .slice(0, limit);
    const nextCursor = entries.at(-1)?.cursor ?? cursor ?? null;
    return { entries, nextCursor };
  }

  async alarm(): Promise<void> {
    const nowMs = Date.now();
    for (const prefix of ["nonce:", "idempotency:"] as const) {
      const records = await this.ctx.storage.list<number | StoredIdempotencyRecord>({ prefix });
      const expired: string[] = [];
      let nextExpiry: number | null = null;
      for (const [key, value] of records) {
        const expiresAtMs = typeof value === "number" ? value : value.expiresAtMs;
        if (expiresAtMs <= nowMs) expired.push(key);
        else nextExpiry = nextExpiry === null ? expiresAtMs : Math.min(nextExpiry, expiresAtMs);
      }
      if (expired.length > 0) await this.ctx.storage.delete(expired);
      if (nextExpiry !== null) await this.scheduleCleanup(this.ctx.storage, nextExpiry);
    }
  }

  private appendLogEntries(
    runtime: StoredRuntime,
    level: RuntimeLogEntry["level"],
    messages: string[],
  ): void {
    for (const message of messages) {
      if (!message) continue;
      runtime.nextLogSequence += 1;
      runtime.logs.push({
        cursor: formatCursor(runtime.nextLogSequence),
        timestamp: new Date().toISOString(),
        level,
        message,
      });
    }
    if (runtime.logs.length > MAX_RUNTIME_LOGS) {
      runtime.logs.splice(0, runtime.logs.length - MAX_RUNTIME_LOGS);
    }
  }

  private async scheduleCleanup(storage: DurableObjectStorage, expiresAtMs: number): Promise<void> {
    const alarm = await storage.getAlarm();
    if (alarm === null || expiresAtMs < alarm) await storage.setAlarm(expiresAtMs);
  }
}
