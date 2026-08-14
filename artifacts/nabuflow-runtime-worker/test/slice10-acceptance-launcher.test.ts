import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const launcher = readFileSync(resolve(here, "../scripts/slice10-cloudflare-acceptance.ts"), "utf8");

describe("Slice 10 acceptance launcher rotation custody", () => {
  it("requires the synchronized signer pair together", () => {
    expect(launcher).toContain(
      "(SESSION_CONTROL_TOKEN === undefined) === (SESSION_PREVIEW_PRIVATE_KEY === undefined)",
    );
    expect(launcher).toContain(
      "Session control token and preview private key must be supplied together",
    );
  });

  it("reuses a session-synchronized signer without rotating the Worker", () => {
    const reuseBranch = launcher.indexOf("if (reuseSessionRotation)");
    const rotateBranch = launcher.indexOf("if (!reuseSessionRotation)");
    const bulkCall = launcher.indexOf('[wranglerCli, "secret", "bulk"');

    expect(reuseBranch).toBeGreaterThan(0);
    expect(launcher).toContain('record("runtime.rotation.session-reused"');
    expect(rotateBranch).toBeGreaterThan(reuseBranch);
    expect(bulkCall).toBeGreaterThan(rotateBranch);
  });

  it("still performs the established atomic rotation when no signer is supplied", () => {
    expect(launcher).toContain("let controlToken = SESSION_CONTROL_TOKEN ?? secret()");
    expect(launcher).toContain('record("runtime.rotation.atomic"');
    expect(launcher).toContain("CLOUDFLARE_CAPABILITY_VAULT_KEK_V1: vaultKek");
  });
});
