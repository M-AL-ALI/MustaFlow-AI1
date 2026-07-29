import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { logger } from "./logger";

const SYSTEM_CHROMIUM_PATHS = [
  "/nix/var/nix/profiles/default/bin/chromium",
  "/run/current-system/sw/bin/chromium",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/usr/bin/google-chrome",
] as const;

const PATH_COMMANDS = ["chromium", "chromium-browser", "google-chrome"] as const;

export type ChromiumExecutableResolution =
  | {
      found: true;
      executablePath: string;
      source: string;
      checkedSources: string[];
    }
  | {
      found: false;
      checkedSources: string[];
    };

type ChromiumProbeOptions = {
  env?: NodeJS.ProcessEnv;
  bundledExecutablePath?: string | null;
  knownPaths?: readonly string[];
  canExecute?: (path: string) => Promise<boolean>;
  findOnPath?: (command: string) => Promise<string | null>;
};

async function canExecuteFile(path: string): Promise<boolean> {
  if (!isAbsolute(path)) return false;
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function findCommandOnPath(command: string): Promise<string | null> {
  const locator = process.platform === "win32" ? "where.exe" : "which";
  return new Promise((resolvePromise) => {
    execFile(locator, [command], { timeout: 2_000, windowsHide: true }, (error, stdout) => {
      if (error) {
        resolvePromise(null);
        return;
      }
      const firstPath = stdout
        .split(/\r?\n/)
        .map((value) => value.trim())
        .find(Boolean);
      resolvePromise(firstPath ?? null);
    });
  });
}

export async function resolveChromiumExecutable(
  options: ChromiumProbeOptions = {},
): Promise<ChromiumExecutableResolution> {
  const env = options.env ?? process.env;
  const canExecute = options.canExecute ?? canExecuteFile;
  const findOnPath = options.findOnPath ?? findCommandOnPath;
  const knownPaths = options.knownPaths ?? SYSTEM_CHROMIUM_PATHS;
  const checkedSources: string[] = [];
  const checkedPaths = new Set<string>();

  const checkCandidate = async (
    path: string | null | undefined,
    source: string,
  ): Promise<ChromiumExecutableResolution | null> => {
    checkedSources.push(source);
    const normalized = path?.trim();
    if (!normalized || checkedPaths.has(normalized)) return null;
    checkedPaths.add(normalized);
    if (!(await canExecute(normalized))) return null;
    return {
      found: true,
      executablePath: normalized,
      source,
      checkedSources: [...checkedSources],
    };
  };

  for (const key of [
    "PLAYWRIGHT_EXECUTABLE_PATH",
    "PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH",
  ] as const) {
    const result = await checkCandidate(env[key], `env:${key}`);
    if (result) return result;
  }

  for (const command of PATH_COMMANDS) {
    let path: string | null;
    try {
      path = await findOnPath(command);
    } catch {
      path = null;
    }
    const result = await checkCandidate(path, `PATH:${command}`);
    if (result) return result;
  }

  for (const path of knownPaths) {
    const result = await checkCandidate(path, `known:${path}`);
    if (result) return result;
  }

  const bundledResult = await checkCandidate(options.bundledExecutablePath, "playwright:bundled");
  if (bundledResult) return bundledResult;

  return { found: false, checkedSources };
}

let startupProbe: Promise<ChromiumExecutableResolution> | null = null;

async function probeBuilderChromiumAtStartup(): Promise<ChromiumExecutableResolution> {
  let bundledExecutablePath: string | null = null;
  try {
    const { chromium } = await import("playwright");
    bundledExecutablePath = chromium.executablePath();
  } catch {
    // The resolver can still find the Nix-provided executable. The QA run
    // reports a separate, non-fatal error if the Playwright package is absent.
  }

  const result = await resolveChromiumExecutable({ bundledExecutablePath });
  if (result.found) {
    logger.info(
      { executablePath: result.executablePath, source: result.source },
      "builder-qa: Chromium browser found at startup",
    );
  } else {
    logger.warn(
      { checkedSources: result.checkedSources },
      "builder-qa: Chromium browser not found at startup; QA will be deferred",
    );
  }
  return result;
}

export function startBuilderChromiumStartupProbe(): void {
  startupProbe ??= probeBuilderChromiumAtStartup().catch((error) => {
    logger.warn({ err: error }, "builder-qa: Chromium startup check failed; QA will be deferred");
    return { found: false, checkedSources: ["startup-check-error"] };
  });
  void startupProbe;
}
