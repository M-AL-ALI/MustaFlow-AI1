/**
 * TypeScript Checker
 *
 * For mobile (Expo/React Native) projects: writes generated .ts/.tsx files to a
 * temp directory with a minimal tsconfig matching Expo SDK 52 settings, runs
 * `tsc --noEmit`, captures stderr, and parses error lines into TsError objects.
 *
 * TypeScript errors in mobile projects are blocking — the build retries once
 * with the error list injected into the correction prompt.
 */
import { execFile } from "child_process";
import { mkdtemp, writeFile, mkdir, rm } from "fs/promises";
import { join, dirname, resolve, sep } from "path";
import { tmpdir } from "os";
import { promisify } from "util";
import type { BuilderFile } from "../builder";
import type { CheckFinding, CheckRunStatus } from "@workspace/db";
import { logger } from "../logger";

const execFileAsync = promisify(execFile);

export type TsError = {
  file: string;
  line: number | null;
  column: number | null;
  code: string;
  message: string;
};

/** Minimal tsconfig that matches Expo SDK 52 / React Native NativeWind v4 setup. */
const EXPO_TSCONFIG = {
  compilerOptions: {
    target: "ES2020",
    lib: ["ES2020"],
    module: "ESNext",
    moduleResolution: "bundler",
    jsx: "react-native",
    strict: false,
    noEmit: true,
    allowJs: true,
    esModuleInterop: true,
    allowSyntheticDefaultImports: true,
    resolveJsonModule: true,
    skipLibCheck: true,
    noUnusedLocals: false,
    noUnusedParameters: false,
  },
  include: ["**/*.ts", "**/*.tsx"],
  exclude: ["node_modules"],
};

/** Parse tsc stderr/stdout into structured TsError objects. */
export function parseTscOutput(output: string, tmpDir: string): TsError[] {
  const errors: TsError[] = [];
  // tsc emits lines like: path/to/file.tsx(10,5): error TS2345: Argument of type ...
  const lineRegex = /^(.+?)\((\d+),(\d+)\):\s+error\s+(TS\d+):\s+(.+)$/;

  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const match = lineRegex.exec(trimmed);
    if (!match) continue;

    const [, rawPath, lineStr, colStr, code, message] = match;
    if (!rawPath) continue;

    // Strip the temp dir prefix to get relative path
    const resolved = resolve(rawPath);
    const resolvedTmp = resolve(tmpDir);
    const relPath = resolved.startsWith(resolvedTmp + sep)
      ? resolved.slice(resolvedTmp.length + 1)
      : rawPath;

    errors.push({
      file: relPath.replace(/\\/g, "/"),
      line: lineStr ? parseInt(lineStr, 10) : null,
      column: colStr ? parseInt(colStr, 10) : null,
      code: code ?? "TS0000",
      message: (message ?? "").trim(),
    });
  }

  return errors;
}

/** Sanitise a file path so it can't escape the temp dir. */
function sanitizeFilePath(filePath: string): string {
  const parts = filePath.split(/[/\\]/).filter(Boolean);
  const safe: string[] = [];
  for (const part of parts) {
    if (part === ".." || part === ".") continue;
    safe.push(part);
  }
  return safe.length > 0 ? safe.join("/") : "file.ts";
}

function isTsFile(file: BuilderFile): boolean {
  return (
    file.mimeType === "application/typescript" ||
    file.path.endsWith(".ts") ||
    file.path.endsWith(".tsx")
  );
}

/**
 * Format TsError list into a human-readable error block suitable for
 * injecting into an AI correction prompt.
 */
export function formatTsErrors(errors: TsError[]): string {
  return errors
    .slice(0, 30) // cap to avoid oversized prompts
    .map((e) => {
      const loc =
        e.line !== null ? ` (line ${e.line}${e.column !== null ? `:${e.column}` : ""})` : "";
      return `${e.file}${loc}: [${e.code}] ${e.message}`;
    })
    .join("\n");
}

/**
 * Run tsc --noEmit against the TS/TSX files in a generated file set.
 * Returns { status, findings, errors } compatible with the check orchestrator.
 * `errors` is the raw TsError list for use in the mobile build retry.
 */
export async function runTsCheck(files: BuilderFile[]): Promise<{
  status: CheckRunStatus;
  findings: CheckFinding[];
  errors: TsError[];
}> {
  const tsFiles = files.filter(isTsFile);

  if (tsFiles.length === 0) {
    return { status: "pass", findings: [], errors: [] };
  }

  let tmpDir: string | null = null;

  try {
    tmpDir = await mkdtemp(join(tmpdir(), "mustaflow-ts-"));

    // Write TS/TSX files to temp dir
    for (const file of tsFiles) {
      const safePath = sanitizeFilePath(file.path);
      const filePath = join(tmpDir, safePath);
      const resolved = resolve(filePath);
      const resolvedTmp = resolve(tmpDir);
      if (!resolved.startsWith(resolvedTmp + sep)) {
        logger.warn({ path: file.path }, "ts-checker: skipping file with unsafe path");
        continue;
      }
      await mkdir(dirname(filePath), { recursive: true });
      await writeFile(filePath, file.content, "utf8");
    }

    // Write minimal tsconfig
    await writeFile(join(tmpDir, "tsconfig.json"), JSON.stringify(EXPO_TSCONFIG, null, 2), "utf8");

    // Find tsc binary — prefer workspace-local
    const tscBin = join(process.cwd(), "node_modules", ".bin", "tsc");

    let rawOutput = "";
    try {
      await execFileAsync(tscBin, ["--noEmit", "--project", join(tmpDir, "tsconfig.json")], {
        timeout: 60_000,
        maxBuffer: 5 * 1024 * 1024,
        cwd: tmpDir,
      });
      // Exit code 0 → no errors
    } catch (execErr: unknown) {
      const err = execErr as { stdout?: string; stderr?: string; code?: number; message?: string };
      // tsc exits with code 1+ when there are type errors — that's expected
      rawOutput = [err.stdout ?? "", err.stderr ?? ""].join("\n");
    }

    const errors = parseTscOutput(rawOutput, tmpDir);

    const findings: CheckFinding[] = errors.map((e) => ({
      file: e.file,
      line: e.line ?? undefined,
      message: `[${e.code}] ${e.message}`,
      detail: `TypeScript error at ${e.file}${e.line !== null ? `:${e.line}` : ""}`,
      severity: "error" as const,
    }));

    const status: CheckRunStatus = errors.length === 0 ? "pass" : "fail";

    return { status, findings, errors };
  } catch (err) {
    logger.warn({ err }, "ts-checker: unexpected error — skipping");
    return { status: "skipped", findings: [], errors: [] };
  } finally {
    if (tmpDir) {
      rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}
