import { describe, expect, it } from "vitest";
import { sha256Hex } from "@workspace/tenant-runtime-contracts";
import { capturePantryBuildResource } from "../src/pantry-build-resource";

function input(overrides: Partial<Parameters<typeof capturePantryBuildResource>[0]> = {}) {
  return {
    schemaVersion: 1 as const,
    parentRevisionRootSha256: "a".repeat(64),
    url: "https://assets.example.test/build-input.bin",
    expectedSha256: null,
    maxBytes: 1024,
    requestedAt: "2026-08-08T20:00:00.000Z",
    ...overrides,
  };
}

describe("trusted Pantry build-resource capture", () => {
  it("follows bounded HTTPS redirects and verifies an exact content digest", async () => {
    const bytes = new TextEncoder().encode("captured-build-input\n");
    const expectedSha256 = await sha256Hex(bytes);
    const calls: string[] = [];
    const captured = await capturePantryBuildResource(input({ expectedSha256 }), async (url) => {
      calls.push(String(url));
      if (calls.length === 1) {
        return new Response(null, {
          status: 302,
          headers: { location: "https://cdn.example.test/v1/input.bin" },
        });
      }
      return new Response(bytes, {
        headers: {
          "content-type": "application/octet-stream",
          "content-length": String(bytes.length),
        },
      });
    });
    expect(calls).toEqual([
      "https://assets.example.test/build-input.bin",
      "https://cdn.example.test/v1/input.bin",
    ]);
    expect(captured).toMatchObject({
      url: "https://cdn.example.test/v1/input.bin",
      contentSha256: expectedSha256,
      redirects: 1,
    });
    expect(captured.bytes).toEqual(bytes);
  });

  it("fails closed for integrity misses, private destinations, cookies, and size bombs", async () => {
    const fetcher = async () =>
      new Response("wrong", { headers: { "content-type": "text/plain" } });
    await expect(
      capturePantryBuildResource(input({ expectedSha256: "b".repeat(64) }), fetcher),
    ).rejects.toMatchObject({ code: "integrity_mismatch" });
    await expect(
      capturePantryBuildResource(input({ url: "https://127.0.0.1/resource" }), fetcher),
    ).rejects.toMatchObject({ code: "integrity_mismatch" });
    await expect(
      capturePantryBuildResource(
        input(),
        async () => new Response("value", { headers: { "set-cookie": "secret=value" } }),
      ),
    ).rejects.toMatchObject({ code: "integrity_mismatch" });
    await expect(
      capturePantryBuildResource(
        input({ maxBytes: 4 }),
        async () => new Response("oversized", { headers: { "content-length": "9" } }),
      ),
    ).rejects.toMatchObject({ code: "stocking_size_limit" });
  });
});
