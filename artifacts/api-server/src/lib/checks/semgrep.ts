import { execFile } from "child_process";
import { mkdtemp, writeFile, mkdir, rm } from "fs/promises";
import { join, dirname, resolve, sep } from "path";
import { tmpdir } from "os";
import { promisify } from "util";
import type { BuilderFile } from "../builder";
import type { CheckFinding, CheckRunStatus } from "@workspace/db";
import { logger } from "../logger";

const execFileAsync = promisify(execFile);

const RULES_CACHE_BASE = join(tmpdir(), "mustaflow-semgrep-cache");

let resolvedVersion: string | null = null;
let resolvedCacheDir: string | null = null;
let warmCachePromise: Promise<void> | null = null;

export type SemgrepResult = {
  checkName: "semgrep-sast";
  status: CheckRunStatus;
  findings: CheckFinding[];
};

type SemgrepJsonResult = {
  results: Array<{
    check_id: string;
    path: string;
    start: { line: number; col: number };
    extra: {
      message: string;
      severity: string;
      metadata?: Record<string, unknown>;
    };
  }>;
  errors?: Array<{ message: string }>;
};

function mapSemgrepSeverity(semgrepSeverity: string): "error" | "warning" | "info" {
  const s = semgrepSeverity.toUpperCase();
  if (s === "ERROR") return "error";
  if (s === "WARNING") return "warning";
  return "info";
}

function sanitizeFilePath(filePath: string): string {
  const parts = filePath.split(/[/\\]/).filter(Boolean);
  const safe: string[] = [];
  for (const part of parts) {
    if (part === ".." || part === ".") continue;
    safe.push(part);
  }
  return safe.length > 0 ? safe.join("/") : "file.js";
}

function isJsOrHtml(file: BuilderFile): boolean {
  return (
    file.mimeType === "text/html" ||
    file.mimeType === "text/javascript" ||
    file.mimeType === "application/javascript" ||
    file.mimeType === "application/typescript" ||
    file.path.endsWith(".html") ||
    file.path.endsWith(".js") ||
    file.path.endsWith(".ts") ||
    file.path.endsWith(".tsx") ||
    file.path.endsWith(".jsx")
  );
}

async function isSemgrepAvailable(): Promise<boolean> {
  try {
    await execFileAsync("semgrep", ["--version"], { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

async function getSemgrepVersion(): Promise<string> {
  if (resolvedVersion !== null) return resolvedVersion;
  try {
    const { stdout } = await execFileAsync("semgrep", ["--version"], { timeout: 5000 });
    resolvedVersion =
      stdout
        .trim()
        .split("\n")[0]
        ?.replace(/[^a-zA-Z0-9._-]/g, "-") ?? "unknown";
  } catch {
    resolvedVersion = "unknown";
  }
  return resolvedVersion;
}

/**
 * Returns the persistent, version-keyed cache directory for semgrep rule packs.
 * The directory is created on first access. Using this as SEMGREP_HOME tells
 * semgrep to store and read its registry cache from this location instead of
 * the default ~/.semgrep, which may not persist across restarts.
 */
async function getRulesCacheDir(): Promise<string> {
  if (resolvedCacheDir !== null) return resolvedCacheDir;
  const version = await getSemgrepVersion();
  const cacheDir = join(RULES_CACHE_BASE, version);
  await mkdir(cacheDir, { recursive: true });
  resolvedCacheDir = cacheDir;
  return cacheDir;
}

/**
 * Pre-fetches the p/javascript and p/security-audit rule packs into a persistent,
 * version-keyed cache directory so subsequent scans skip the network round-trip.
 *
 * Call this once at server startup (fire-and-forget). Safe to call multiple
 * times — only one warm-up runs concurrently; the rest join the same promise.
 */
export function warmSemgrepRuleCache(): Promise<void> {
  if (warmCachePromise) return warmCachePromise;
  warmCachePromise = doWarmCache();
  return warmCachePromise;
}

async function doWarmCache(): Promise<void> {
  const available = await isSemgrepAvailable();
  if (!available) return;

  let cacheDir: string;
  try {
    cacheDir = await getRulesCacheDir();
  } catch (err) {
    logger.warn({ err }, "semgrep: failed to create rule cache directory — skipping warm-up");
    return;
  }

  let dummyDir: string | null = null;
  try {
    dummyDir = await mkdtemp(join(tmpdir(), "mustaflow-semgrep-warm-"));
    await writeFile(join(dummyDir, "warm.js"), "var x = 1;\n", "utf8");

    try {
      await execFileAsync(
        "semgrep",
        [
          "--config=p/javascript",
          "--config=p/security-audit",
          "--json",
          "--no-git-ignore",
          "--metrics=off",
          dummyDir,
        ],
        {
          timeout: 120_000,
          maxBuffer: 10 * 1024 * 1024,
          env: {
            ...process.env,
            SEMGREP_HOME: cacheDir,
            SEMGREP_SEND_METRICS: "off",
          },
        },
      );
      logger.info({ cacheDir }, "semgrep rule cache warmed successfully");
    } catch (execErr: unknown) {
      const err = execErr as { stdout?: string; code?: number };
      if (err.stdout && err.stdout.trim().startsWith("{")) {
        logger.info({ cacheDir }, "semgrep rule cache warmed successfully");
      } else {
        logger.warn(
          { err: execErr },
          "semgrep rule cache warm-up failed — remote rules will be fetched on first scan",
        );
        warmCachePromise = null;
      }
    }
  } catch (err) {
    logger.warn({ err }, "semgrep rule cache warm-up encountered unexpected error");
    warmCachePromise = null;
  } finally {
    if (dummyDir) {
      rm(dummyDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

export async function runSemgrepCheck(files: BuilderFile[]): Promise<SemgrepResult> {
  const available = await isSemgrepAvailable();
  if (!available) {
    logger.warn("semgrep not available in PATH — skipping semgrep-sast check");
    return { checkName: "semgrep-sast", status: "skipped", findings: [] };
  }

  const targetFiles = files.filter(isJsOrHtml);
  if (targetFiles.length === 0) {
    return { checkName: "semgrep-sast", status: "pass", findings: [] };
  }

  let cacheDir: string | undefined;
  try {
    cacheDir = await getRulesCacheDir();
  } catch {
    // Non-fatal: fall back to remote rule fetch without a SEMGREP_HOME override
  }

  let tmpDir: string | null = null;

  try {
    tmpDir = await mkdtemp(join(tmpdir(), "mustaflow-semgrep-"));

    for (const file of targetFiles) {
      const safePath = sanitizeFilePath(file.path);
      const filePath = join(tmpDir, safePath);
      const resolved = resolve(filePath);
      const resolvedTmp = resolve(tmpDir);
      if (!resolved.startsWith(resolvedTmp + sep)) {
        logger.warn({ path: file.path }, "semgrep: skipping file with unsafe path");
        continue;
      }
      const fileDir = dirname(filePath);
      await mkdir(fileDir, { recursive: true });
      await writeFile(filePath, file.content, "utf8");
    }

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      SEMGREP_SEND_METRICS: "off",
    };
    if (cacheDir) {
      env["SEMGREP_HOME"] = cacheDir;
    }

    let stdout = "";
    try {
      const result = await execFileAsync(
        "semgrep",
        [
          "--config=p/javascript",
          "--config=p/security-audit",
          "--json",
          "--no-git-ignore",
          "--metrics=off",
          tmpDir,
        ],
        {
          timeout: 60_000,
          maxBuffer: 10 * 1024 * 1024,
          env,
        },
      );
      stdout = result.stdout;
    } catch (execErr: unknown) {
      const err = execErr as { stdout?: string; stderr?: string; code?: number };
      if (err.stdout && err.stdout.trim().startsWith("{")) {
        stdout = err.stdout;
      } else {
        logger.warn({ err: execErr }, "semgrep execution failed — skipping semgrep-sast check");
        return { checkName: "semgrep-sast", status: "skipped", findings: [] };
      }
    }

    let parsed: SemgrepJsonResult;
    try {
      parsed = JSON.parse(stdout) as SemgrepJsonResult;
    } catch {
      logger.warn("semgrep returned non-JSON output — skipping semgrep-sast check");
      return { checkName: "semgrep-sast", status: "skipped", findings: [] };
    }

    const findings: CheckFinding[] = (parsed.results ?? []).map((r) => {
      const relPath = r.path.startsWith(tmpDir!) ? r.path.slice(tmpDir!.length + 1) : r.path;
      return {
        file: relPath,
        line: r.start.line,
        message: r.extra.message.trim().slice(0, 300),
        detail: `Rule: ${r.check_id}`,
        severity: mapSemgrepSeverity(r.extra.severity),
      };
    });

    const status: CheckRunStatus =
      findings.length === 0
        ? "pass"
        : findings.some((f) => f.severity === "error")
          ? "fail"
          : "warning";

    return { checkName: "semgrep-sast", status, findings };
  } catch (err) {
    logger.warn({ err }, "Unexpected error running semgrep — skipping semgrep-sast check");
    return { checkName: "semgrep-sast", status: "skipped", findings: [] };
  } finally {
    if (tmpDir) {
      rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}
