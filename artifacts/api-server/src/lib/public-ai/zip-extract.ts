/**
 * Safe ZIP archive extraction for Ora (GitHub repo downloads, zipped projects).
 *
 * Everything happens IN MEMORY — nothing is ever written to disk and nothing
 * inside the archive is ever executed. The archive is treated purely as a
 * container of text to read.
 *
 * Zip-bomb / abuse guards:
 * - Hard cap on central-directory entries scanned (throws beyond it).
 * - Only allowlisted text/code file extensions are ever inflated.
 * - Dependency/VCS/build directories (node_modules, .git, dist, ...) are skipped.
 * - Per-file uncompressed size cap and a running total inflate cap, enforced
 *   BEFORE inflation via central-directory headers and re-verified AFTER
 *   inflation (headers can lie).
 * - Nested archives are never recursed into (archive extensions are not in the
 *   text allowlist).
 *
 * The digest is budget-aware: with MAX_TEXT_CHARS_PER_FILE as the ceiling, the
 * most useful files (README, manifests, docs, shallow source files) are
 * included first so the model sees the most informative slice of the repo.
 */

import { unzipSync } from "fflate";
import { MAX_TEXT_CHARS_PER_FILE } from "./file-store";

export type ZipExtractionCode =
  | "too-many-entries"
  | "no-readable-files"
  | "invalid-zip";

export class ZipExtractionError extends Error {
  readonly code: ZipExtractionCode;
  constructor(code: ZipExtractionCode, message: string) {
    super(message);
    this.name = "ZipExtractionError";
    this.code = code;
  }
}

// ── Guard rails ─────────────────────────────────────────────────────────────
const MAX_SCANNED_ENTRIES = 60_000; // central-directory entries before we call it a bomb
const MAX_ACCEPTED_FILES = 400; // files we will actually inflate
const MAX_PER_FILE_BYTES = 256 * 1024; // per-file uncompressed cap
const MAX_TOTAL_INFLATED_BYTES = 32 * 1024 * 1024; // running total inflate cap
const MAX_TREE_PATHS = 150; // paths listed in the digest tree
const MAX_TREE_CHARS = 4_000; // char budget for the tree section
const MAX_CHARS_PER_FILE_IN_DIGEST = 6_000; // display slice per included file

const TEXT_FILE_EXTENSIONS = new Set([
  ".md", ".markdown", ".txt", ".rst", ".adoc",
  ".json", ".yaml", ".yml", ".toml", ".ini", ".cfg", ".conf", ".properties",
  ".env.example", ".env.sample", ".env.template",
  ".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs", ".mts", ".cts",
  ".py", ".rb", ".php", ".go", ".rs", ".java", ".kt", ".kts", ".swift",
  ".c", ".h", ".cpp", ".hpp", ".cc", ".hh", ".cs", ".m", ".mm",
  ".scala", ".clj", ".ex", ".exs", ".erl", ".lua", ".r", ".jl", ".dart",
  ".sh", ".bash", ".zsh", ".fish", ".ps1", ".bat", ".cmd",
  ".sql", ".prisma", ".graphql", ".gql", ".proto",
  ".html", ".htm", ".css", ".scss", ".less", ".sass",
  ".vue", ".svelte", ".astro",
  ".xml", ".plist", ".gradle", ".sbt", ".cmake", ".mk",
  ".tf", ".tfvars", ".nix", ".dockerfile", ".editorconfig",
  ".gitignore", ".gitattributes", ".npmrc", ".nvmrc", ".babelrc", ".eslintrc",
  ".prettierrc", ".lock",
]);

const SPECIAL_FILENAMES = new Set([
  "dockerfile", "makefile", "rakefile", "gemfile", "procfile", "justfile",
  "license", "notice", "authors", "contributors", "changelog", "codeowners",
  "vagrantfile", "brewfile", "cmakelists.txt",
]);

const MANIFEST_FILENAMES = new Set([
  "package.json", "pyproject.toml", "requirements.txt", "setup.py", "setup.cfg",
  "go.mod", "cargo.toml", "composer.json", "gemfile", "pom.xml", "build.gradle",
  "build.gradle.kts", "app.json", "tsconfig.json", "docker-compose.yml",
  "docker-compose.yaml", "dockerfile", "makefile", "pnpm-workspace.yaml",
  "deno.json", "mix.exs", "pubspec.yaml", "project.clj",
]);

const IGNORED_DIR_SEGMENTS = new Set([
  "node_modules", ".git", "dist", "build", "out", ".next", ".nuxt", "coverage",
  "vendor", "__pycache__", ".venv", "venv", "target", "pods", ".idea",
  ".vscode", ".cache", ".expo", "deriveddata", ".pnpm-store", ".yarn",
  "bower_components", ".gradle", ".terraform", ".mypy_cache", ".pytest_cache",
  ".ruff_cache", ".turbo", ".svn", ".hg",
]);

// Lockfiles are text but low-signal and huge; list them in the tree, skip contents.
const LOW_SIGNAL_FILENAMES = new Set([
  "package-lock.json", "pnpm-lock.yaml", "yarn.lock", "cargo.lock",
  "composer.lock", "gemfile.lock", "poetry.lock", "go.sum",
]);

function baseName(path: string): string {
  const idx = path.lastIndexOf("/");
  return (idx >= 0 ? path.slice(idx + 1) : path).toLowerCase();
}

function extOf(name: string): string {
  const base = baseName(name);
  const dot = base.lastIndexOf(".");
  return dot >= 0 ? base.slice(dot) : "";
}

function isIgnoredPath(path: string): boolean {
  if (path.includes("__MACOSX")) return true;
  const segments = path.split("/");
  for (const seg of segments) {
    const s = seg.toLowerCase();
    if (IGNORED_DIR_SEGMENTS.has(s)) return true;
    if (s.startsWith("._")) return true; // macOS resource forks
  }
  return false;
}

function isTextCandidate(path: string): boolean {
  const base = baseName(path);
  if (SPECIAL_FILENAMES.has(base)) return true;
  if (base.startsWith("readme") || base.startsWith("license")) return true;
  // Compound suffixes like ".env.example" won't match extOf; check endsWith.
  for (const compound of [".env.example", ".env.sample", ".env.template"]) {
    if (base.endsWith(compound)) return true;
  }
  return TEXT_FILE_EXTENSIONS.has(extOf(path));
}

/** Depth relative to the repo root, ignoring GitHub's single wrapper folder. */
function pathDepth(path: string, rootPrefix: string): number {
  const rel = rootPrefix && path.startsWith(rootPrefix) ? path.slice(rootPrefix.length) : path;
  return rel.split("/").length - 1;
}

/** Lower score = read first. */
function priorityScore(path: string, rootPrefix: string): number {
  const base = baseName(path);
  const depth = pathDepth(path, rootPrefix);
  if (base.startsWith("readme")) return depth === 0 ? 0 : 1;
  if (MANIFEST_FILENAMES.has(base)) return 2 + depth * 0.1;
  if (extOf(path) === ".md" || extOf(path) === ".markdown") return 4 + depth * 0.1;
  return 6 + depth;
}

function looksLikeBinaryContent(bytes: Uint8Array): boolean {
  if (bytes.length === 0) return true;
  const sample = bytes.subarray(0, Math.min(bytes.length, 4096));
  let printable = 0;
  for (let i = 0; i < sample.length; i++) {
    const b = sample[i]!;
    if (b === 0x09 || b === 0x0a || b === 0x0d || (b >= 0x20 && b <= 0x7e) || b >= 0x80) {
      printable++;
    }
    if (b === 0x00) return true; // NUL byte → treat as binary
  }
  return printable / sample.length < 0.85;
}

/**
 * GitHub "Download ZIP" wraps everything in a single "<repo>-<branch>/" folder.
 * Detect a common single top-level folder so depth scoring and the tree stay
 * meaningful.
 */
function detectRootPrefix(paths: string[]): string {
  if (paths.length === 0) return "";
  const first = paths[0]!;
  const slash = first.indexOf("/");
  if (slash <= 0) return "";
  const prefix = first.slice(0, slash + 1);
  return paths.every((p) => p.startsWith(prefix)) ? prefix : "";
}

export function extractZipDigest(buffer: Buffer): string {
  let scanned = 0;
  let acceptedCount = 0;
  let acceptedBytes = 0;
  let skippedLarge = 0;
  const allFilePaths: string[] = [];

  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(new Uint8Array(buffer), {
      filter: (info) => {
        scanned++;
        if (scanned > MAX_SCANNED_ENTRIES) {
          throw new ZipExtractionError(
            "too-many-entries",
            "This ZIP archive contains too many files to analyze. Please upload a smaller archive.",
          );
        }
        const name = info.name;
        if (!name || name.endsWith("/")) return false; // directory entry
        if (isIgnoredPath(name)) return false;
        // Record every non-ignored file for the tree (bounded).
        if (allFilePaths.length < 5_000) allFilePaths.push(name);
        if (!isTextCandidate(name)) return false;
        if (LOW_SIGNAL_FILENAMES.has(baseName(name))) return false;
        // Cap BOTH the claimed uncompressed size and the compressed stream
        // size. A lying header could claim a tiny originalSize while shipping
        // a huge deflate stream that would burn CPU on the request thread.
        if (info.originalSize > MAX_PER_FILE_BYTES || info.size > MAX_PER_FILE_BYTES) {
          skippedLarge++;
          return false;
        }
        if (acceptedCount >= MAX_ACCEPTED_FILES) return false;
        if (acceptedBytes + info.originalSize > MAX_TOTAL_INFLATED_BYTES) return false;
        acceptedCount++;
        acceptedBytes += info.originalSize;
        return true;
      },
    });
  } catch (err) {
    if (err instanceof ZipExtractionError) throw err;
    throw new ZipExtractionError(
      "invalid-zip",
      "This ZIP archive could not be read. It may be corrupted, encrypted, or use an unsupported compression format.",
    );
  }

  const rootPrefix = detectRootPrefix(allFilePaths);

  // Post-inflate verification (headers can lie) + binary sniff + decode.
  const readable: Array<{ path: string; content: string; score: number }> = [];
  for (const [path, bytes] of Object.entries(files)) {
    if (bytes.length > MAX_PER_FILE_BYTES * 1.5) continue; // lying header
    if (looksLikeBinaryContent(bytes)) continue;
    const content = Buffer.from(bytes).toString("utf8").replace(/\u0000/g, "").trim();
    if (!content) continue;
    readable.push({ path, content, score: priorityScore(path, rootPrefix) });
  }

  if (readable.length === 0) {
    throw new ZipExtractionError(
      "no-readable-files",
      "This ZIP archive contains no readable text or code files. Ora can read source code, documentation, and configuration files inside ZIP archives.",
    );
  }

  readable.sort((a, b) => a.score - b.score || a.path.localeCompare(b.path));

  // ── Assemble the budget-aware digest ────────────────────────────────────
  const displayPath = (p: string): string =>
    rootPrefix && p.startsWith(rootPrefix) ? p.slice(rootPrefix.length) : p;

  const header =
    `[ZIP archive${rootPrefix ? ` "${rootPrefix.slice(0, -1)}"` : ""}: ` +
    `${allFilePaths.length}${allFilePaths.length >= 5_000 ? "+" : ""} files, ` +
    `${readable.length} readable text/code files` +
    (skippedLarge > 0 ? `, ${skippedLarge} skipped as too large` : "") +
    `]\n`;

  let tree = "File tree:\n";
  const treePaths = allFilePaths.slice(0, MAX_TREE_PATHS).map(displayPath).sort();
  for (const p of treePaths) {
    if (tree.length + p.length + 1 > MAX_TREE_CHARS) break;
    tree += p + "\n";
  }
  if (allFilePaths.length > MAX_TREE_PATHS) {
    tree += `... (+${allFilePaths.length - MAX_TREE_PATHS} more files)\n`;
  }

  let digest = header + "\n" + tree + "\n";
  let included = 0;
  for (const file of readable) {
    const remaining = MAX_TEXT_CHARS_PER_FILE - digest.length;
    if (remaining < 400) break;
    const slice = file.content.slice(0, Math.min(MAX_CHARS_PER_FILE_IN_DIGEST, remaining - 100));
    const truncatedNote = slice.length < file.content.length ? "\n[... file truncated]" : "";
    digest += `=== FILE: ${displayPath(file.path)} ===\n${slice}${truncatedNote}\n\n`;
    included++;
  }
  if (included < readable.length) {
    digest += `[Note: ${readable.length - included} more readable files were found but did not fit in the analysis window. Ask about specific files by name to explore further.]\n`;
  }

  return digest;
}
