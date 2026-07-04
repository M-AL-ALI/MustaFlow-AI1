/**
 * Phase 2I — Safe local project inspector.
 *
 * Reads filesystem metadata only. No shell commands, no secrets, no
 * node_modules/.git traversal, no arbitrary recursion.
 */
import fs from "node:fs";
import path from "node:path";

export interface ProjectInspectionScript {
  name: string;
  command: string;
}

export interface ProjectInspectionWarning {
  message: string;
}

export interface ProjectInspectionResult {
  rootName: string;
  localPath: string;
  hasGit: boolean;
  gitBranch: string | null;
  packageManager: "pnpm" | "yarn" | "npm" | "bun" | null;
  frameworkHints: string[];
  scripts: ProjectInspectionScript[];
  keyFiles: string[];
  topLevelEntries: string[];
  ignoredEntries: string[];
  warnings: ProjectInspectionWarning[];
  summaryText: string;
}

// ── Safety constants ────────────────────────────────────────────────────────

const BLOCKED_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "out",
  "coverage",
  ".next",
  ".expo",
  ".turbo",
  ".cache",
  "__pycache__",
]);

const BLOCKED_FILE_PATTERNS: RegExp[] = [
  /^\.env(\..*)?$/,
  /\.pem$/i,
  /\.key$/i,
  /^id_rsa/,
  /^secrets\./,
  /\.p8$/i,
  /\.pfx$/i,
  /\.cer$/i,
  /\.p12$/i,
];

const SAFE_CONFIG_FILES = new Set([
  "package.json",
  "pnpm-workspace.yaml",
  "tsconfig.json",
  "vite.config.ts",
  "vite.config.js",
  "vite.config.mts",
  "next.config.js",
  "next.config.ts",
  "next.config.mjs",
  "app.json",
  "expo.json",
  "README.md",
  "turbo.json",
  "nx.json",
]);

const MAX_DEPTH = 3;
const MAX_FILES = 200;
const MAX_PACKAGE_JSON_BYTES = 200 * 1024;
const MAX_README_BYTES = 8 * 1024;

// ── Helpers ─────────────────────────────────────────────────────────────────

function isBlockedFile(name: string): boolean {
  return BLOCKED_FILE_PATTERNS.some((p) => p.test(name));
}

function isBlockedDir(name: string): boolean {
  return BLOCKED_DIRS.has(name);
}

function readPackageJsonScripts(pkgPath: string): ProjectInspectionScript[] {
  try {
    const stat = fs.statSync(pkgPath);
    if (stat.size > MAX_PACKAGE_JSON_BYTES) return [];
    const raw = fs.readFileSync(pkgPath, "utf8");
    const pkg = JSON.parse(raw) as { scripts?: Record<string, string> };
    if (!pkg.scripts || typeof pkg.scripts !== "object") return [];
    return Object.entries(pkg.scripts)
      .filter(([k]) => /^(typecheck|lint|test|build|dev|start|format|check|quality)/.test(k))
      .slice(0, 20)
      .map(([name, command]) => ({ name, command: String(command) }));
  } catch {
    return [];
  }
}

function detectPackageManager(
  rootPath: string,
): "pnpm" | "yarn" | "npm" | "bun" | null {
  if (fs.existsSync(path.join(rootPath, "pnpm-lock.yaml"))) return "pnpm";
  if (fs.existsSync(path.join(rootPath, "yarn.lock"))) return "yarn";
  if (fs.existsSync(path.join(rootPath, "bun.lockb"))) return "bun";
  if (fs.existsSync(path.join(rootPath, "package-lock.json"))) return "npm";
  return null;
}

function detectFrameworks(rootPath: string, topEntries: string[]): string[] {
  const hints: string[] = [];
  const hasEntry = (name: string) => topEntries.includes(name);
  const hasFile = (name: string) =>
    hasEntry(name) || fs.existsSync(path.join(rootPath, name));

  if (hasFile("pnpm-workspace.yaml") || hasFile("turbo.json")) {
    hints.push("pnpm monorepo");
  }
  if (hasFile("vite.config.ts") || hasFile("vite.config.js")) hints.push("Vite");
  if (
    hasFile("next.config.js") ||
    hasFile("next.config.ts") ||
    hasFile("next.config.mjs")
  ) {
    hints.push("Next.js");
  }

  // Detect Expo by checking app.json for an "expo" key
  const appJsonPath = path.join(rootPath, "app.json");
  if (fs.existsSync(appJsonPath)) {
    try {
      const appJson = JSON.parse(
        fs.readFileSync(appJsonPath, "utf8"),
      ) as { expo?: unknown };
      if (appJson.expo) hints.push("Expo / React Native");
    } catch {
      /* skip malformed */
    }
  }

  if (hasFile("tsconfig.json")) hints.push("TypeScript");
  if (hasEntry("artifacts") || hasEntry("packages")) {
    hints.push("monorepo workspace");
  }

  return hints;
}

/**
 * Read the current git branch by parsing .git/HEAD directly.
 * No shell/spawn — pure fs read.
 */
function readGitBranch(rootPath: string): string | null {
  const headPath = path.join(rootPath, ".git", "HEAD");
  try {
    if (!fs.existsSync(headPath)) return null;
    const content = fs.readFileSync(headPath, "utf8").trim();
    const match = content.match(/^ref: refs\/heads\/(.+)$/);
    return match ? match[1] ?? null : content.slice(0, 12) || null;
  } catch {
    return null;
  }
}

function collectTopLevelEntries(
  dir: string,
  ignored: string[],
): { entries: string[]; fileCount: number } {
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return { entries: [], fileCount: 0 };
  }

  let fileCount = 0;
  const result: string[] = [];

  for (const name of entries) {
    if (fileCount >= MAX_FILES) break;
    if (isBlockedDir(name)) {
      ignored.push(name);
      continue;
    }
    if (isBlockedFile(name)) {
      ignored.push(name);
      continue;
    }
    result.push(name);
    fileCount++;
  }

  return { entries: result, fileCount };
}

function buildSummaryText(
  result: Omit<ProjectInspectionResult, "summaryText">,
): string {
  const lines: string[] = [
    `Orax connected to ${result.rootName} and inspected the local workspace.`,
    "",
  ];

  const detections: string[] = [...result.frameworkHints];
  if (result.hasGit) {
    const branchSuffix = result.gitBranch ? ` on branch ${result.gitBranch}` : "";
    detections.push(`Git repository${branchSuffix}`);
  }
  if (result.packageManager) {
    detections.push(`Package manager: ${result.packageManager}`);
  }

  if (detections.length > 0) {
    lines.push("Detected:");
    for (const d of detections) lines.push(`- ${d}`);
  }

  if (result.scripts.length > 0) {
    lines.push("");
    lines.push("Useful scripts:");
    for (const s of result.scripts.slice(0, 8)) {
      lines.push(`- ${s.name}: ${s.command}`);
    }
  }

  for (const w of result.warnings) {
    lines.push(``, `Warning: ${w.message}`);
  }

  lines.push(
    "",
    "Next: I can inspect the files related to your request and prepare the first change.",
  );
  return lines.join("\n");
}

// ── Public API ───────────────────────────────────────────────────────────────

export async function inspectLocalProject(
  localPath: string,
): Promise<ProjectInspectionResult> {
  const rootName = path.basename(localPath);
  const ignored: string[] = [];

  const { entries: topLevelEntries, fileCount } = collectTopLevelEntries(
    localPath,
    ignored,
  );

  const hasGit = fs.existsSync(path.join(localPath, ".git"));
  const gitBranch = hasGit ? readGitBranch(localPath) : null;
  const packageManager = detectPackageManager(localPath);
  const frameworkHints = detectFrameworks(localPath, topLevelEntries);
  const keyFiles = [...SAFE_CONFIG_FILES].filter((f) =>
    topLevelEntries.includes(f),
  );

  const pkgPath = path.join(localPath, "package.json");
  const scripts = fs.existsSync(pkgPath)
    ? readPackageJsonScripts(pkgPath)
    : [];

  // README preview (first MAX_README_BYTES only, ignored in summaryText)
  const readmePath = path.join(localPath, "README.md");
  let _readmePreview: string | null = null;
  if (fs.existsSync(readmePath)) {
    try {
      const buf = Buffer.alloc(MAX_README_BYTES);
      const fd = fs.openSync(readmePath, "r");
      const bytesRead = fs.readSync(fd, buf, 0, MAX_README_BYTES, 0);
      fs.closeSync(fd);
      _readmePreview = buf.subarray(0, bytesRead).toString("utf8");
    } catch {
      /* skip */
    }
  }

  const warnings: ProjectInspectionWarning[] = [];
  if (fileCount >= MAX_FILES) {
    warnings.push({
      message: `Inspection reached the ${MAX_FILES}-file limit; some entries may be omitted.`,
    });
  }

  const partial: Omit<ProjectInspectionResult, "summaryText"> = {
    rootName,
    localPath,
    hasGit,
    gitBranch,
    packageManager,
    frameworkHints,
    scripts,
    keyFiles,
    topLevelEntries,
    ignoredEntries: [...new Set(ignored)],
    warnings,
  };

  return { ...partial, summaryText: buildSummaryText(partial) };
}
