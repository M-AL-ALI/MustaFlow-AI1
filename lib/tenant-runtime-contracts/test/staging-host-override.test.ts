import { describe, expect, it } from "vitest";
import { signStagingHostOverride, verifyStagingHostOverride, type ControlNonceStore } from "../src";

const SECRET = "0123456789abcdef0123456789abcdef";
const NOW_MS = 1_785_859_200_000;

class MemoryNonceStore implements ControlNonceStore {
  readonly nonces = new Set<string>();

  async consumeOnce(nonce: string): Promise<boolean> {
    if (this.nonces.has(nonce)) return false;
    this.nonces.add(nonce);
    return true;
  }
}

function fields() {
  return {
    method: "POST",
    pathAndQuery: "/echo?published=true",
    timestamp: String(NOW_MS),
    nonce: "override-test-nonce-0001",
    actualHost: "nabuflow-runtime-staging.mustafa-alali74.workers.dev",
    overrideHost: "scratch.apps.mustaflow.com",
  };
}

describe("staging hostname override signatures", () => {
  it("accepts once and rejects replay, tampering, and clock skew", async () => {
    const nonceStore = new MemoryNonceStore();
    const signature = await signStagingHostOverride(SECRET, fields());
    const signed = { ...fields(), signature };

    await expect(
      verifyStagingHostOverride(SECRET, signed, nonceStore, { nowMs: NOW_MS }),
    ).resolves.toEqual({ ok: true });
    await expect(
      verifyStagingHostOverride(SECRET, signed, nonceStore, { nowMs: NOW_MS }),
    ).resolves.toEqual({ ok: false, reason: "replay" });

    await expect(
      verifyStagingHostOverride(
        SECRET,
        { ...signed, nonce: "override-test-nonce-0002", overrideHost: "other.apps.mustaflow.com" },
        new MemoryNonceStore(),
        { nowMs: NOW_MS },
      ),
    ).resolves.toEqual({ ok: false, reason: "signature-mismatch" });

    await expect(
      verifyStagingHostOverride(
        SECRET,
        { ...signed, nonce: "override-test-nonce-0003" },
        new MemoryNonceStore(),
        { nowMs: NOW_MS + 60_001 },
      ),
    ).resolves.toEqual({ ok: false, reason: "clock-skew" });
  });

  it("rejects malformed hostnames without throwing", async () => {
    await expect(
      verifyStagingHostOverride(
        SECRET,
        { ...fields(), overrideHost: "BAD HOST", signature: "0".repeat(64) },
        new MemoryNonceStore(),
        { nowMs: NOW_MS },
      ),
    ).resolves.toEqual({ ok: false, reason: "malformed" });
  });
});
