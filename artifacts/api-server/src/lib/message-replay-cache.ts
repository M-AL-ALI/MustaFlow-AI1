import { SendMessageResponse } from "@workspace/api-zod";
import { z } from "zod";

export type MessageReplayKind = "regular" | "stream";
export interface MessageReplayScope {
  actorId: string | undefined;
  projectId: number;
  kind: MessageReplayKind;
  operation: string;
}

interface ReplayEntry {
  status: "in-flight" | "done";
  result?: unknown;
  timestamp: number;
}
type ReplayLookup =
  | ReplayEntry
  | {
      status: "done-other-format";
      result?: undefined;
      timestamp: number;
    };
interface StoredEntry extends ReplayEntry {
  claim: symbol;
  kind: MessageReplayKind;
}

// A runtime parser, not a cast: do not replay arbitrary fields as SSE events.
const streamResponse = z.object({
  userMessageId: z.number().int().positive(),
  assistantMessageId: z.number().int().positive(),
  plan: z.record(z.string(), z.unknown()),
  terminal: z.unknown().optional(),
});

/** Process-local retry optimization, not a replacement for durable admission. */
export class MessageReplayCache {
  private readonly entries = new Map<string, StoredEntry>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly ttlMs = 5 * 60 * 1000,
  ) {}

  private live(key: string): StoredEntry | undefined {
    const entry = this.entries.get(key);
    // Execution lifetime is not replay lifetime. The request's finally block
    // releases an unfinished claim; only completed replies expire by time.
    if (entry?.status === "done" && this.now() - entry.timestamp >= this.ttlMs) {
      this.entries.delete(key);
      return undefined;
    }
    return entry;
  }

  prune(): void {
    for (const key of this.entries.keys()) this.live(key);
  }

  forRequest(scope: MessageReplayScope) {
    const enabled =
      typeof scope.actorId === "string" &&
      scope.actorId.length > 0 &&
      Number.isSafeInteger(scope.projectId) &&
      scope.projectId > 0 &&
      (scope.kind === "regular" || scope.kind === "stream") &&
      typeof scope.operation === "string" &&
      scope.operation.length > 0;
    // One execution claim across formats; the stored kind gates serialization.
    // Snapshot all scope values rather than retaining a mutable caller object.
    const prefix = [scope.actorId, scope.projectId, scope.operation];
    const kind = scope.kind;
    const schema = kind === "regular" ? SendMessageResponse : streamResponse;
    const claim = Symbol("message-replay-request");
    const claimed = new Set<string>();
    const scopedKey = (key: string) => JSON.stringify([...prefix, key]);

    return {
      get: (key: string): ReplayLookup | undefined => {
        if (!enabled) return undefined;
        const identity = scopedKey(key);
        const entry = this.live(identity);
        if (!entry) return undefined;
        if (entry.status === "in-flight") {
          return { status: entry.status, timestamp: entry.timestamp };
        }
        if (entry.kind !== kind) {
          return { status: "done-other-format", timestamp: entry.timestamp };
        }
        const parsed = schema.safeParse(entry.result);
        if (!parsed.success) {
          this.entries.delete(identity);
          return undefined;
        }
        return { status: "done", result: parsed.data, timestamp: entry.timestamp };
      },
      set: (key: string, entry: ReplayEntry): boolean => {
        if (!enabled) return false;
        const identity = scopedKey(key);
        const existing = this.live(identity);
        if (entry.status === "in-flight") {
          if (existing) return false;
          this.entries.set(identity, {
            status: "in-flight",
            timestamp: this.now(),
            claim,
            kind,
          });
          claimed.add(identity);
          return true;
        }
        if (!existing || existing.claim !== claim || existing.status !== "in-flight") {
          return false;
        }
        const parsed = schema.safeParse(entry.result);
        if (!parsed.success) {
          this.entries.delete(identity);
          claimed.delete(identity);
          return false;
        }
        this.entries.set(identity, {
          status: "done",
          result: parsed.data,
          timestamp: this.now(),
          claim,
          kind,
        });
        claimed.delete(identity);
        return true;
      },
      delete: (key: string): boolean => {
        if (!enabled) return false;
        const identity = scopedKey(key);
        const entry = this.entries.get(identity);
        // Delivery failure after a successful completion must not erase replay.
        if (entry?.claim !== claim || entry.status !== "in-flight") return false;
        claimed.delete(identity);
        return this.entries.delete(identity);
      },
      releasePending: (): void => {
        for (const identity of claimed) {
          const entry = this.entries.get(identity);
          if (entry?.claim === claim && entry.status === "in-flight") {
            this.entries.delete(identity);
          }
        }
        claimed.clear();
      },
    };
  }
}
