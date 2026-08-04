import { describe, expect, it } from "vitest";
import {
  canonicalizeControlRequest,
  constantTimeHexEqual,
  sha256Hex,
  signControlRequest,
  verifyControlRequestSignature,
} from "../src/request-signing";
import type { ControlNonceStore } from "../src/request-signing";

const TEST_VECTOR = {
  secret: "0123456789abcdef0123456789abcdef",
  body: '{"projectId":42}',
  fields: {
    method: "POST",
    pathAndQuery: "/_nabuflow/control/v1/runtimes/42/preview/primary/start?wait=true",
    timestamp: "1785859200000",
    nonce: "01JXYZABCDEF0123456789ABCD",
    bodySha256: "63e3cf682f2319d705ec920c8d78d555ec5b465d8ef83be0e6e0e476cba562a2",
    idempotencyKey: "runtime-start-42-0001",
  },
  canonical:
    "POST\n/_nabuflow/control/v1/runtimes/42/preview/primary/start?wait=true\n1785859200000\n01JXYZABCDEF0123456789ABCD\n63e3cf682f2319d705ec920c8d78d555ec5b465d8ef83be0e6e0e476cba562a2\nruntime-start-42-0001",
  signature: "83afa15033d2649dc94448bacc80ea19dd336304d76a52d7621e01be3118d3e9",
} as const;

class MemoryNonceStore implements ControlNonceStore {
  readonly consumed = new Map<string, number>();

  async consumeOnce(nonce: string, expiresAtMs: number): Promise<boolean> {
    if (this.consumed.has(nonce)) return false;
    this.consumed.set(nonce, expiresAtMs);
    return true;
  }
}

describe("control request signing", () => {
  it("matches the fixed cross-runtime SHA-256 and HMAC-SHA256 test vector", async () => {
    expect(await sha256Hex(TEST_VECTOR.body)).toBe(TEST_VECTOR.fields.bodySha256);
    expect(canonicalizeControlRequest(TEST_VECTOR.fields)).toBe(TEST_VECTOR.canonical);
    expect(await signControlRequest(TEST_VECTOR.secret, TEST_VECTOR.fields)).toBe(
      TEST_VECTOR.signature,
    );
  });

  it("accepts a valid request exactly once and records the replay window", async () => {
    const store = new MemoryNonceStore();
    const signed = {
      ...TEST_VECTOR.fields,
      signature: TEST_VECTOR.signature,
      body: TEST_VECTOR.body,
    };

    await expect(
      verifyControlRequestSignature(TEST_VECTOR.secret, signed, store, {
        nowMs: 1_785_859_200_000,
      }),
    ).resolves.toEqual({ ok: true });
    expect(store.consumed.get(TEST_VECTOR.fields.nonce)).toBe(1_785_859_260_000);
    await expect(
      verifyControlRequestSignature(TEST_VECTOR.secret, signed, store, {
        nowMs: 1_785_859_200_000,
      }),
    ).resolves.toEqual({ ok: false, reason: "replay" });
  });

  it("fails closed on stale timestamps with configurable clock skew", async () => {
    const signed = {
      ...TEST_VECTOR.fields,
      signature: TEST_VECTOR.signature,
      body: TEST_VECTOR.body,
    };
    await expect(
      verifyControlRequestSignature(TEST_VECTOR.secret, signed, new MemoryNonceStore(), {
        nowMs: 1_785_859_261_000,
      }),
    ).resolves.toEqual({ ok: false, reason: "clock-skew" });
    await expect(
      verifyControlRequestSignature(TEST_VECTOR.secret, signed, new MemoryNonceStore(), {
        nowMs: 1_785_859_261_000,
        maxClockSkewMs: 61_000,
      }),
    ).resolves.toEqual({ ok: true });
  });

  it.each([
    ["tampered body", { body: '{"projectId":43}' }, "body-hash-mismatch"],
    ["tampered body hash", { bodySha256: "0".repeat(64) }, "body-hash-mismatch"],
    ["tampered signature", { signature: "0".repeat(64) }, "signature-mismatch"],
    ["lowercase method", { method: "post" }, "malformed"],
    ["absolute URL", { pathAndQuery: "https://example.com/control" }, "malformed"],
    ["newline nonce", { nonce: "valid-nonce-value\nforged" }, "malformed"],
    ["ambiguous timestamp", { timestamp: "17858592000" }, "malformed"],
  ] as const)("rejects %s without consuming its nonce", async (_name, change, reason) => {
    const store = new MemoryNonceStore();
    const request = {
      ...TEST_VECTOR.fields,
      signature: TEST_VECTOR.signature,
      body: TEST_VECTOR.body,
      ...change,
    };
    await expect(
      verifyControlRequestSignature(TEST_VECTOR.secret, request, store, {
        nowMs: 1_785_859_200_000,
      }),
    ).resolves.toEqual({ ok: false, reason });
    expect(store.consumed).toHaveLength(0);
  });

  it("uses fixed-width comparison and rejects malformed encodings", () => {
    expect(constantTimeHexEqual("a".repeat(64), "a".repeat(64))).toBe(true);
    expect(constantTimeHexEqual("a".repeat(64), `${"a".repeat(63)}b`)).toBe(false);
    expect(constantTimeHexEqual("a", "a")).toBe(false);
    expect(constantTimeHexEqual("g".repeat(64), "g".repeat(64))).toBe(false);
    expect(constantTimeHexEqual("A".repeat(64), "A".repeat(64))).toBe(false);
  });

  it("rejects signing secrets shorter than 32 bytes", async () => {
    await expect(signControlRequest("too-short", TEST_VECTOR.fields)).rejects.toThrow(
      "at least 32 bytes",
    );
  });
});
