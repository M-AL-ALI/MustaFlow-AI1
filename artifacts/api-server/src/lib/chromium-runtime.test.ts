import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { resolveChromiumExecutable } from "./chromium-runtime";

describe("builder Chromium runtime", () => {
  it("prefers an executable PLAYWRIGHT_EXECUTABLE_PATH", async () => {
    const canExecute = vi.fn(async (path: string) => path === "/sandbox/chromium");
    const findOnPath = vi.fn(async () => "/nix/store/path-chromium");

    const result = await resolveChromiumExecutable({
      env: {
        PLAYWRIGHT_EXECUTABLE_PATH: "/sandbox/chromium",
        PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH: "/legacy/chromium",
      },
      knownPaths: [],
      canExecute,
      findOnPath,
    });

    expect(result).toMatchObject({
      found: true,
      executablePath: "/sandbox/chromium",
      source: "env:PLAYWRIGHT_EXECUTABLE_PATH",
    });
    expect(findOnPath).not.toHaveBeenCalled();
  });

  it("finds the Nix-provided Chromium on PATH and verifies it is executable", async () => {
    const findOnPath = vi.fn(async (command: string) =>
      command === "chromium" ? "/nix/store/chromium/bin/chromium" : null,
    );
    const canExecute = vi.fn(async (path: string) => path === "/nix/store/chromium/bin/chromium");

    const result = await resolveChromiumExecutable({
      env: {},
      knownPaths: [],
      findOnPath,
      canExecute,
    });

    expect(result).toMatchObject({
      found: true,
      executablePath: "/nix/store/chromium/bin/chromium",
      source: "PATH:chromium",
    });
    expect(canExecute).toHaveBeenCalledWith("/nix/store/chromium/bin/chromium");
  });

  it("reports a bounded missing-browser result instead of inventing a path", async () => {
    const result = await resolveChromiumExecutable({
      env: {},
      bundledExecutablePath: "/missing/playwright/chromium",
      knownPaths: [],
      findOnPath: async () => null,
      canExecute: async () => false,
    });

    expect(result.found).toBe(false);
    expect(result.checkedSources).toContain("playwright:bundled");
  });

  it("declares Chromium in the deployment Nix package list", async () => {
    const replitConfig = await readFile(new URL("../../../../.replit", import.meta.url), "utf8");
    expect(replitConfig).toMatch(/\[nix\][\s\S]*?packages\s*=\s*\["chromium"\]/);
  });
});
