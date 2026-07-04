/**
 * Phase 2J — Safe local project file selector.
 *
 * Walks the project directory and scores candidate files against the user's
 * request message + inspection result. Pure filesystem metadata reads — no
 * file content, no shell commands, no secrets.
 */
import fs from "node:fs";
import path from "node:path";
import type { ProjectInspectionResult } from "./project-inspector";

// ── Public types ─────────────────────────────────────────────────────────────

export type FileCategory =
  | "auth"
  | "routing"
  | "ui"
  | "api"
  | "config"
  | "tests"
  | "docs"
  | "package"
  | "unknown";

export interface SelectedProjectFile {
  relativePath: string;
  reason: string;
  score: number;
  category: FileCategory;
}

export interface ProjectFileSelectionResult {
  files: SelectedProjectFile[];
  skipped: { relativePath: string; reason: string }[];
  warnings: { message: string }[];
}

// ── Safety constants ─────────────────────────────────────────────────────────

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
  /^credentials\./,
  /^token\./,
];

const ALLOWED_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".json",
  ".md",
  ".css",
  ".scss",
  ".html",
  ".yml",
  ".yaml",
  ".toml",
  ".mjs",
  ".cjs",
]);

const MAX_TRAVERSAL_DEPTH = 5;
const MAX_CANDIDATE_FILES = 500;
const MAX_SELECTED_FILES = 8;

// ── Helpers ──────────────────────────────────────────────────────────────────

function isBlockedFile(name: string): boolean {
  return BLOCKED_FILE_PATTERNS.some((p) => p.test(name));
}

function getExt(filename: string): string {
  // Handle double extensions like .config.ts, .config.js
  const lower = filename.toLowerCase();
  if (lower.endsWith(".config.ts")) return ".config.ts";
  if (lower.endsWith(".config.js")) return ".config.js";
  if (lower.endsWith(".config.mjs")) return ".config.mjs";
  const idx = lower.lastIndexOf(".");
  return idx >= 0 ? lower.slice(idx) : "";
}

function extractKeywords(message: string): string[] {
  const lower = message.toLowerCase();
  const tokens = lower.split(/[\s,./\-_:;'"()[\]{}]+/).filter((t) => t.length >= 3);
  const stopwords = new Set([
    "the", "and", "for", "with", "that", "this", "from", "are", "can", "you",
    "how", "what", "when", "why", "not", "get", "let", "make", "use", "try",
    "add", "new", "old", "run", "set", "put", "our", "was", "all", "has",
  ]);
  const seen = new Set<string>();
  return tokens
    .filter((t) => !stopwords.has(t) && /^[a-z0-9]+$/.test(t) && !seen.has(t) && seen.add(t))
    .slice(0, 20);
}

interface CategoryRule {
  pattern: RegExp;
  cat: FileCategory;
  boost: number;
}

const CATEGORY_RULES: CategoryRule[] = [
  { pattern: /auth|login|session|clerk|oauth|middleware\/auth|sign.?in|credential/, cat: "auth", boost: 4 },
  { pattern: /route|router|routing|navigation|redirect/, cat: "routing", boost: 3 },
  { pattern: /page|screen|component|layout|ui|modal|view|panel/, cat: "ui", boost: 2 },
  { pattern: /api|server|handler|controller|endpoint|request|fetch/, cat: "api", boost: 3 },
  { pattern: /config|settings|vite\.config|next\.config|tsconfig|app\.json|turbo\.json|workspace/, cat: "config", boost: 2 },
  { pattern: /test|spec|__tests__|\.test\.|\.spec\./, cat: "tests", boost: 1 },
  { pattern: /readme|docs|changelog|\.md$/, cat: "docs", boost: 1 },
  { pattern: /package\.json|pnpm.workspace|yarn\.lock|package.lock/, cat: "package", boost: 3 },
];

function scoreFile(
  relPath: string,
  keywords: string[],
): { score: number; category: FileCategory; reason: string } {
  const lower = relPath.toLowerCase().replace(/\\/g, "/");
  const parts = lower.split("/");
  const filename = parts[parts.length - 1] ?? "";

  let score = 0;
  let category: FileCategory = "unknown";
  let reason = "";

  for (const { pattern, cat, boost } of CATEGORY_RULES) {
    if (pattern.test(lower)) {
      score += boost;
      if (category === "unknown") {
        category = cat;
        reason = reason || `matches ${cat} pattern`;
      }
    }
  }

  for (const kw of keywords) {
    if (lower.includes(kw)) {
      score += 2;
      reason = reason || `path contains "${kw}"`;
    }
  }

  // Depth penalty: deeper files score slightly less unless already high-value
  const depth = parts.length - 1;
  if (depth >= 3) score = Math.max(0, score - (depth - 2));

  // Key file bonuses
  if (filename === "package.json" && parts.length <= 2) {
    score = Math.max(score, 3);
    category = category === "unknown" ? "package" : category;
    reason = reason || "root package.json";
  }
  if (filename === "readme.md") {
    score = Math.max(score, 1);
    category = category === "unknown" ? "docs" : category;
    reason = reason || "project readme";
  }

  return { score, category, reason: reason || "candidate file" };
}

interface CandidateEntry {
  relativePath: string;
  absolutePath: string;
}

function walkForCandidates(
  dir: string,
  rootPath: string,
  depth: number,
  candidates: CandidateEntry[],
): void {
  if (depth > MAX_TRAVERSAL_DEPTH || candidates.length >= MAX_CANDIDATE_FILES) return;

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (candidates.length >= MAX_CANDIDATE_FILES) break;
    const name = entry.name;

    if (entry.isDirectory()) {
      if (BLOCKED_DIRS.has(name)) continue;
      walkForCandidates(path.join(dir, name), rootPath, depth + 1, candidates);
    } else if (entry.isFile()) {
      if (isBlockedFile(name)) continue;
      const ext = getExt(name);
      if (!ALLOWED_EXTENSIONS.has(ext)) continue;
      const absPath = path.join(dir, name);
      const relPath = path.relative(rootPath, absPath);
      candidates.push({ relativePath: relPath, absolutePath: absPath });
    }
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function selectRelevantProjectFiles(params: {
  localPath: string;
  userMessage: string;
  inspection: ProjectInspectionResult;
}): Promise<ProjectFileSelectionResult> {
  const { localPath, userMessage } = params;
  const warnings: { message: string }[] = [];

  const candidates: CandidateEntry[] = [];
  walkForCandidates(localPath, localPath, 0, candidates);

  if (candidates.length >= MAX_CANDIDATE_FILES) {
    warnings.push({
      message: `File scan reached the ${MAX_CANDIDATE_FILES}-file limit; some files may be omitted from selection.`,
    });
  }

  const keywords = extractKeywords(userMessage);

  const scored = candidates.map((c) => {
    const { score, category, reason } = scoreFile(c.relativePath, keywords);
    return { ...c, score, category, reason };
  });

  // Sort: highest score first, then alphabetically for ties
  scored.sort((a, b) => b.score - a.score || a.relativePath.localeCompare(b.relativePath));

  const selected: SelectedProjectFile[] = [];
  for (const c of scored) {
    if (selected.length >= MAX_SELECTED_FILES) break;
    if (c.score <= 0) break;
    selected.push({
      relativePath: c.relativePath,
      reason: c.reason,
      score: c.score,
      category: c.category,
    });
  }

  // If nothing matched by score, fall back to package.json + README
  if (selected.length === 0) {
    for (const candidate of candidates) {
      const name = candidate.relativePath.toLowerCase().replace(/\\/g, "/");
      if (name === "package.json" || name === "readme.md") {
        selected.push({
          relativePath: candidate.relativePath,
          reason: "no strong match — fallback to key files",
          score: 0,
          category: name === "package.json" ? "package" : "docs",
        });
      }
      if (selected.length >= 2) break;
    }
  }

  return {
    files: selected,
    skipped: [],
    warnings,
  };
}
