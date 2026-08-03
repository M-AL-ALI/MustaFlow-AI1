import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createEncryptionService } from "./encryption";
import {
  buildRuntimeSecretMap,
  redactSecretMapValues,
  secretCanInjectAtRuntime,
} from "./project-secret-policy";

const here = path.dirname(fileURLToPath(import.meta.url));

describe("project secret encryption", () => {
  const service = createEncryptionService(Buffer.alloc(32, 7).toString("base64"));

  it("encrypts at rest, decrypts at the injection boundary, and authenticates ciphertext", () => {
    const plaintext = "sk-live-super-private";
    const encrypted = service.encrypt(plaintext);

    expect(encrypted).toMatch(/^v1:/);
    expect(encrypted).not.toContain(plaintext);
    expect(service.decrypt(encrypted)).toBe(plaintext);

    const parts = encrypted.split(":");
    const tag = parts[3] ?? "";
    parts[3] = `${tag.startsWith("A") ? "B" : "A"}${tag.slice(1)}`;
    const tampered = parts.join(":");
    expect(() => service.decrypt(tampered)).toThrow();
  });
});

describe("project secret runtime injection policy", () => {
  const previewSafe = {
    environment: "development",
    isPreviewSafe: true,
    minRole: "viewer",
  };

  it("injects preview-safe draft values into build and preview but never production", () => {
    expect(secretCanInjectAtRuntime(previewSafe, "build")).toBe(true);
    expect(secretCanInjectAtRuntime(previewSafe, "preview")).toBe(true);
    expect(secretCanInjectAtRuntime(previewSafe, "production")).toBe(false);
  });

  it("injects production values only into the published runtime", () => {
    const production = { ...previewSafe, environment: "production", isPreviewSafe: false };
    expect(secretCanInjectAtRuntime(production, "build")).toBe(false);
    expect(secretCanInjectAtRuntime(production, "preview")).toBe(false);
    expect(secretCanInjectAtRuntime(production, "production")).toBe(true);
  });

  it("rejects draft values that are not explicitly preview-safe", () => {
    expect(secretCanInjectAtRuntime({ ...previewSafe, isPreviewSafe: false }, "preview")).toBe(
      false,
    );
    expect(secretCanInjectAtRuntime({ ...previewSafe, minRole: "owner" }, "build")).toBe(false);
  });

  it("constructs isolated build, preview, and published environment maps", () => {
    const entries = [
      { ...previewSafe, name: "DRAFT_TOKEN", valueEncrypted: "enc:draft" },
      {
        environment: "production",
        isPreviewSafe: false,
        minRole: "owner",
        name: "LIVE_TOKEN",
        valueEncrypted: "enc:live",
      },
      { ...previewSafe, name: "BROKEN_TOKEN", valueEncrypted: "broken" },
    ];
    const decrypt = (value: string) => {
      if (value === "broken") throw new Error("bad ciphertext");
      return value.replace("enc:", "plain-");
    };

    expect(buildRuntimeSecretMap(entries, "build", decrypt)).toEqual({
      DRAFT_TOKEN: "plain-draft",
    });
    expect(buildRuntimeSecretMap(entries, "preview", decrypt)).toEqual({
      DRAFT_TOKEN: "plain-draft",
    });
    expect(buildRuntimeSecretMap(entries, "production", decrypt)).toEqual({
      LIVE_TOKEN: "plain-live",
    });
  });

  it("wires the canonical maps into all three server-side runtimes", () => {
    const agentLoop = readFileSync(path.join(here, "agent-loop.ts"), "utf8");
    const preview = readFileSync(path.join(here, "../routes/preview-env.ts"), "utf8");
    const publish = readFileSync(path.join(here, "../routes/publish.ts"), "utf8");
    const versions = readFileSync(path.join(here, "../routes/versions.ts"), "utf8");

    expect(agentLoop).toContain("getBuildSecretMap");
    expect(preview).toContain("getContainerSecretMap");
    expect(publish).toContain("getProductionSecretMap");
    expect(versions).toContain("getProductionSecretMap");
  });
});

describe("project secret redaction", () => {
  it("scrubs every occurrence without changing safe text", () => {
    const value = "secret-value-123";
    expect(redactSecretMapValues(`failed ${value}; retry ${value}`, { API_KEY: value })).toBe(
      "failed [REDACTED:API_KEY]; retry [REDACTED:API_KEY]",
    );
    expect(redactSecretMapValues("ordinary build output", { API_KEY: value })).toBe(
      "ordinary build output",
    );
    expect(redactSecretMapValues("short=abc", { SHORT_SECRET: "abc" })).toBe(
      "short=[REDACTED:SHORT_SECRET]",
    );
  });
});
