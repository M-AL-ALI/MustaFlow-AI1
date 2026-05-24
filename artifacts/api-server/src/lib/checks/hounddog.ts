/**
 * HoundDog SAST scanner — secret/PII leak detection (Task #545).
 *
 * Invokes the `hounddog` CLI (https://hounddog.ai) on a tempdir of project
 * files. Real findings come from HoundDog when the binary is present;
 * gracefully skips with status="skipped" when not installed (same pattern as
 * semgrep.ts). When neither is available the check is invisible — it never
 * blocks builds.
 *
 * Output JSON shape (HoundDog --output json):
 *   { findings: [{ rule_id, severity, file, line, description, ... }] }
 *
 * Severity mapping → CheckFinding.severity:
 *   high|critical → error, medium → warning, else → info.
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

export type HoundDogResult = {
  checkName: "hounddog-sast";
  status: CheckRunStatus;
  findings: CheckFinding[];
};

type HoundDogJson = {
  findings?: Array<{
    rule_id?: string;
    severity?: string;
    file?: string;
    line?: number;
    description?: string;
    message?: string;
  }>;
};

function mapSev(s: string | undefined): "error" | "warning" | "info" {
  const v = (s ?? "").toLowerCase();
  if (v === "critical" || v === "high") return "error";
  if (v === "medium") return "warning";
  return "info";
}

function sanitizeFilePath(filePath: string): string {
  const parts = filePath.split(/[/\\]/).filter(Boolean);
  const safe: string[] = [];
  for (const p of parts) {
    if (p === "." || p === "..") continue;
    safe.push(p);
  }
  return safe.length > 0 ? safe.join("/") : "file";
}

async function isAvailable(): Promise<boolean> {
  try {
    await execFileAsync("hounddog", ["--version"], { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

export async function runHoundDogCheck(files: BuilderFile[]): Promise<HoundDogResult> {
  if (!(await isAvailable())) {
    logger.warn("hounddog CLI not available — skipping hounddog-sast check");
    return { checkName: "hounddog-sast", status: "skipped", findings: [] };
  }
  if (files.length === 0) return { checkName: "hounddog-sast", status: "pass", findings: [] };

  let dir: string | null = null;
  try {
    dir = await mkdtemp(join(tmpdir(), "mustaflow-hounddog-"));
    for (const f of files) {
      const safe = sanitizeFilePath(f.path);
      const full = join(dir, safe);
      const resolved = resolve(full);
      const resolvedRoot = resolve(dir);
      if (!resolved.startsWith(resolvedRoot + sep)) continue;
      await mkdir(dirname(full), { recursive: true });
      await writeFile(full, f.content, "utf8");
    }

    let stdout = "";
    try {
      const r = await execFileAsync(
        "hounddog",
        ["scan", "--format", "json", "--no-color", dir],
        { timeout: 60_000, maxBuffer: 10 * 1024 * 1024 },
      );
      stdout = r.stdout;
    } catch (err: unknown) {
      const e = err as { stdout?: string };
      if (e.stdout && e.stdout.trim().startsWith("{")) stdout = e.stdout;
      else {
        logger.warn({ err }, "hounddog execution failed — skipping");
        return { checkName: "hounddog-sast", status: "skipped", findings: [] };
      }
    }

    let parsed: HoundDogJson;
    try {
      parsed = JSON.parse(stdout) as HoundDogJson;
    } catch {
      return { checkName: "hounddog-sast", status: "skipped", findings: [] };
    }

    const findings: CheckFinding[] = (parsed.findings ?? []).map((f) => {
      const rel = (f.file ?? "").startsWith(dir!) ? f.file!.slice(dir!.length + 1) : (f.file ?? "");
      return {
        file: rel || "unknown",
        line: f.line ?? 0,
        message: (f.description ?? f.message ?? "HoundDog finding").trim().slice(0, 300),
        detail: `Rule: ${f.rule_id ?? "unknown"}`,
        severity: mapSev(f.severity),
      };
    });

    const status: CheckRunStatus =
      findings.length === 0
        ? "pass"
        : findings.some((x) => x.severity === "error")
          ? "fail"
          : "warning";
    return { checkName: "hounddog-sast", status, findings };
  } catch (err) {
    logger.warn({ err }, "Unexpected hounddog error — skipping");
    return { checkName: "hounddog-sast", status: "skipped", findings: [] };
  } finally {
    if (dir) rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
