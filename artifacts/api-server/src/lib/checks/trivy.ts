/**
 * Trivy filesystem/vulnerability scanner (Task #545).
 *
 * Invokes `trivy fs --format json` on a tempdir of project files. Picks up
 * vulnerable npm/python dependencies via lockfiles (package-lock.json,
 * yarn.lock, pnpm-lock.yaml, requirements.txt, Pipfile.lock, go.sum, Cargo.lock).
 *
 * Gracefully skips when the trivy binary is absent — same pattern as semgrep.ts.
 *
 * Severity mapping → CheckFinding.severity:
 *   CRITICAL|HIGH → error, MEDIUM → warning, LOW|UNKNOWN → info.
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

export type TrivyResult = {
  checkName: "trivy-sast";
  status: CheckRunStatus;
  findings: CheckFinding[];
};

type TrivyJson = {
  Results?: Array<{
    Target?: string;
    Vulnerabilities?: Array<{
      VulnerabilityID?: string;
      PkgName?: string;
      InstalledVersion?: string;
      FixedVersion?: string;
      Severity?: string;
      Title?: string;
      Description?: string;
    }>;
  }>;
};

function mapSev(s: string | undefined): "error" | "warning" | "info" {
  const v = (s ?? "").toUpperCase();
  if (v === "CRITICAL" || v === "HIGH") return "error";
  if (v === "MEDIUM") return "warning";
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

const TRIVY_RELEVANT = [
  "package.json",
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "requirements.txt",
  "Pipfile.lock",
  "Pipfile",
  "go.sum",
  "go.mod",
  "Cargo.lock",
  "Cargo.toml",
  "Gemfile.lock",
  "composer.lock",
  "Dockerfile",
];

function isRelevant(file: BuilderFile): boolean {
  const base = file.path.split("/").pop() ?? "";
  return TRIVY_RELEVANT.includes(base);
}

async function isAvailable(): Promise<boolean> {
  try {
    await execFileAsync("trivy", ["--version"], { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

export async function runTrivyCheck(files: BuilderFile[]): Promise<TrivyResult> {
  if (!(await isAvailable())) {
    logger.warn("trivy CLI not available — skipping trivy-sast check");
    return { checkName: "trivy-sast", status: "skipped", findings: [] };
  }
  const targets = files.filter(isRelevant);
  if (targets.length === 0) return { checkName: "trivy-sast", status: "pass", findings: [] };

  let dir: string | null = null;
  try {
    dir = await mkdtemp(join(tmpdir(), "mustaflow-trivy-"));
    for (const f of targets) {
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
        "trivy",
        [
          "fs",
          "--format",
          "json",
          "--quiet",
          "--scanners",
          "vuln,misconfig,secret",
          "--no-progress",
          dir,
        ],
        {
          timeout: 120_000,
          maxBuffer: 20 * 1024 * 1024,
          env: { ...process.env, TRIVY_DISABLE_VEX_NOTICE: "true" },
        },
      );
      stdout = r.stdout;
    } catch (err: unknown) {
      const e = err as { stdout?: string };
      if (e.stdout && e.stdout.trim().startsWith("{")) stdout = e.stdout;
      else {
        logger.warn({ err }, "trivy execution failed — skipping");
        return { checkName: "trivy-sast", status: "skipped", findings: [] };
      }
    }

    let parsed: TrivyJson;
    try {
      parsed = JSON.parse(stdout) as TrivyJson;
    } catch {
      return { checkName: "trivy-sast", status: "skipped", findings: [] };
    }

    const findings: CheckFinding[] = [];
    for (const result of parsed.Results ?? []) {
      const target = result.Target ?? "";
      const rel = target.startsWith(dir!) ? target.slice(dir!.length + 1) : target;
      for (const v of result.Vulnerabilities ?? []) {
        const msg = `${v.PkgName ?? "?"}@${v.InstalledVersion ?? "?"}: ${v.Title ?? v.VulnerabilityID ?? "vulnerability"}`;
        const fixHint = v.FixedVersion ? ` (fixed in ${v.FixedVersion})` : "";
        findings.push({
          file: rel || "unknown",
          line: 0,
          message: (msg + fixHint).slice(0, 300),
          detail: `${v.VulnerabilityID ?? ""}${v.Description ? ` — ${v.Description.slice(0, 200)}` : ""}`,
          severity: mapSev(v.Severity),
        });
      }
    }

    const status: CheckRunStatus =
      findings.length === 0
        ? "pass"
        : findings.some((x) => x.severity === "error")
          ? "fail"
          : "warning";
    return { checkName: "trivy-sast", status, findings };
  } catch (err) {
    logger.warn({ err }, "Unexpected trivy error — skipping");
    return { checkName: "trivy-sast", status: "skipped", findings: [] };
  } finally {
    if (dir) rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
