import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  chromiumExecutableCandidates,
  isAllowedScreenshotUrl,
  sanitizeCaptureConsoleError,
} from "./agent-senses";

const dir = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(dir, "agent-senses.ts"), "utf8");

describe("snapshot cookie cage", () => {
  it("removes private values before console evidence crosses the capture boundary", () => {
    const sanitized = sanitizeCaptureConsoleError(
      "Request failed for founder@example.com?token=abcdefghijklmnopqrstuvwxyz012345",
    );
    expect(sanitized).toContain("[private email]");
    expect(sanitized).toContain("token=[private value]");
    expect(sanitized).not.toContain("founder@example.com");
    expect(sanitized).not.toContain("abcdefghijklmnopqrstuvwxyz012345");
  });

  it("keeps page overlays independent of ambient browser declarations", () => {
    expect(source).toContain("type OverlayDocument");
    expect(source).not.toContain("document: Document");
  });

  it("discovers content-addressed Nix Chromium from PATH instead of guessing its hash", () => {
    const candidates = chromiumExecutableCandidates(
      "/nix/store/runtime/bin:/nix/store/chromium-hash/bin",
      undefined,
      "linux",
      ":",
    );
    expect(candidates).toContain("/nix/store/chromium-hash/bin/chromium");
    expect(candidates).toContain("/nix/store/chromium-hash/bin/chromium-browser");
  });

  it("keeps an explicit Chromium override first and de-duplicates candidates", () => {
    const candidates = chromiumExecutableCandidates(
      "/runtime/bin:/runtime/bin",
      "/approved/chromium",
      "linux",
      ":",
    );
    expect(candidates[0]).toBe("/approved/chromium");
    expect(new Set(candidates).size).toBe(candidates.length);
  });

  it("allows only the exact declared IPv4 loopback origin through the private-address guard", async () => {
    const trusted = "http://127.0.0.1:8080";
    await expect(
      isAllowedScreenshotUrl("http://127.0.0.1:8080/api/projects/51/preview/", trusted),
    ).resolves.toBe(true);
    await expect(
      isAllowedScreenshotUrl("http://127.0.0.1:8081/api/projects/51/preview/", trusted),
    ).resolves.toBe(false);
    await expect(
      isAllowedScreenshotUrl("http://10.0.0.5:8080/api/projects/51/preview/", trusted),
    ).resolves.toBe(false);
    await expect(
      isAllowedScreenshotUrl(
        "http://127.0.0.1:8080/api/projects/51/preview/",
        "http://localhost:8080",
      ),
    ).resolves.toBe(false);
  });
});
