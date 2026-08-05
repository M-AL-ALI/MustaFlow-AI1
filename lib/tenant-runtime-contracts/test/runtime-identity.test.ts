import { describe, expect, it } from "vitest";
import {
  deriveNamespaceHash,
  deriveRuntimeIdentity,
  parseRuntimeIdentity,
  parseRuntimeIdentityForNamespace,
} from "../src/runtime-identity";

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

describe("runtime identity", () => {
  it("derives a stable 16-hex namespace digest", async () => {
    expect(await deriveNamespaceHash("production-us-east")).toMatch(/^[0-9a-f]{16}$/);
    expect(await deriveNamespaceHash("production-us-east")).toBe(
      await deriveNamespaceHash("production-us-east"),
    );
  });

  it("round-trips all approved role/slot pairs across 2,000 seeded project IDs", async () => {
    const random = seededRandom(0x2b1);
    const pairs = [
      ["preview", "primary"],
      ["production", "blue"],
      ["production", "green"],
    ] as const;

    for (let index = 0; index < 2_000; index += 1) {
      const projectId = 1 + Math.floor(random() * 9_000_000_000);
      const [role, slot] = pairs[index % pairs.length];
      const identity = await deriveRuntimeIdentity({
        namespace: "production-us-east",
        projectId,
        role,
        slot,
      });
      expect(await parseRuntimeIdentityForNamespace(identity, "production-us-east")).toEqual({
        namespaceHash: await deriveNamespaceHash("production-us-east"),
        projectId,
        role,
        slot,
      });
    }
  });

  it("rejects namespace mismatches", async () => {
    const identity = await deriveRuntimeIdentity({
      namespace: "staging-us-east",
      projectId: 42,
      role: "preview",
      slot: "primary",
    });
    await expect(parseRuntimeIdentityForNamespace(identity, "production-us-east")).rejects.toThrow(
      "namespace mismatch",
    );
  });

  it.each([
    "",
    "nrf-123-p1-preview-primary",
    "nrf-0123456789abcdef-p0-preview-primary",
    "nrf-0123456789abcdef-p1-preview-blue",
    "nrf-0123456789abcdef-p1-production-primary",
    "nrf-0123456789abcdef-p1-build-primary",
    "NRF-0123456789ABCDEF-P1-PREVIEW-PRIMARY",
    "nrf-0123456789abcdef-p01-preview-primary",
    "nrf-0123456789abcdef-p1-preview-primary/extra",
    "nrf-0123456789abcdef-p1-preview-primarý",
  ])("rejects malformed or non-normalized identity %j", (identity) => {
    expect(() => parseRuntimeIdentity(identity)).toThrow();
  });

  it("rejects fuzzed strings that do not exactly match the identity grammar", () => {
    const random = seededRandom(0xf022);
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_/:.?-☃";
    for (let sample = 0; sample < 5_000; sample += 1) {
      const length = Math.floor(random() * 100);
      let value = "";
      for (let index = 0; index < length; index += 1) {
        value += alphabet[Math.floor(random() * alphabet.length)];
      }
      expect(() => parseRuntimeIdentity(value)).toThrow();
    }
  });

  it.each(["Prod", "prod_1", "-prod", "prod-", "prod.1", "☃", "a".repeat(64)])(
    "rejects non-normalized deployment namespace %j",
    async (namespace) => {
      await expect(deriveNamespaceHash(namespace)).rejects.toThrow();
    },
  );
});
