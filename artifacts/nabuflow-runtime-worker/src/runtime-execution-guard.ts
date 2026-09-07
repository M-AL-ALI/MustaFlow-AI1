import { RpcTarget } from "cloudflare:workers";
import type { StoredHttpResponse } from "./model";

export interface RuntimeExecutionHandle {
  run(callback: () => Promise<StoredHttpResponse | null>): Promise<StoredHttpResponse | null>;
  close(): void | Promise<void>;
  [Symbol.dispose](): void;
}

/** Keep execution inside the lease RPC so caller/coordinator loss cancels its callback. */
export class RuntimeExecutionLease extends RpcTarget implements RuntimeExecutionHandle {
  #closed = false;
  #running = false;
  readonly #release: () => void;

  constructor(release: () => void) {
    super();
    this.#release = release;
  }

  async run(
    callback: () => Promise<StoredHttpResponse | null>,
  ): Promise<StoredHttpResponse | null> {
    if (this.#closed || this.#running) throw new Error("Runtime execution lease is unavailable");
    this.#running = true;
    try {
      return await callback();
    } finally {
      this.#running = false;
      if (this.#closed) this.#release();
    }
  }

  close(): void {
    this.#closed = true;
    if (!this.#running) this.#release();
  }

  [Symbol.dispose](): void {
    this.close();
  }
}

export class RuntimeExecutionRegistry {
  readonly #active = new Map<string, Map<string, boolean>>();

  get size(): number {
    return this.#active.size;
  }

  acquire(identity: string, token: string, exclusive: boolean): RuntimeExecutionLease | null {
    const entries = this.#active.get(identity) ?? new Map<string, boolean>();
    if (entries.has(token) || entries.size >= 128) return null;
    if (entries.size > 0 && (exclusive || [...entries.values()].some(Boolean))) return null;
    entries.set(token, exclusive);
    this.#active.set(identity, entries);
    return new RuntimeExecutionLease(() => {
      entries.delete(token);
      if (entries.size === 0 && this.#active.get(identity) === entries)
        this.#active.delete(identity);
    });
  }
}
