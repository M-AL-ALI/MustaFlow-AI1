/**
 * Phase 2G — Dependency scanner.
 *
 * Detects external packages that are imported by workspace JS/TS files but
 * absent from package.json's dependency fields.  Pure utility — no side
 * effects, no I/O.  The agent loop calls `scanMissingDeps` before each check
 * run and uses `addMissingToDeps` to patch package.json in-place before
 * triggering a targeted npm install.
 */

export interface DepScanFile {
  path: string;
  content: string;
}

// ─── Node.js built-in module list (Node 18+) ─────────────────────────────────

const NODE_BUILTINS = new Set([
  "assert",
  "assert/strict",
  "async_hooks",
  "buffer",
  "child_process",
  "cluster",
  "console",
  "constants",
  "crypto",
  "dgram",
  "diagnostics_channel",
  "dns",
  "dns/promises",
  "domain",
  "events",
  "fs",
  "fs/promises",
  "http",
  "http2",
  "https",
  "inspector",
  "module",
  "net",
  "os",
  "path",
  "path/posix",
  "path/win32",
  "perf_hooks",
  "process",
  "punycode",
  "querystring",
  "readline",
  "readline/promises",
  "repl",
  "stream",
  "stream/consumers",
  "stream/promises",
  "stream/web",
  "string_decoder",
  "sys",
  "timers",
  "timers/promises",
  "tls",
  "trace_events",
  "tty",
  "url",
  "util",
  "util/types",
  "v8",
  "vm",
  "wasi",
  "worker_threads",
  "zlib",
]);

function isBuiltin(specifier: string): boolean {
  if (specifier.startsWith("node:")) return true;
  return NODE_BUILTINS.has(specifier);
}

/**
 * Reduce an import specifier to its npm package name:
 *   @scope/pkg/subpath  →  @scope/pkg
 *   pkg/subpath         →  pkg
 */
function toPackageName(specifier: string): string {
  if (specifier.startsWith("@")) {
    const parts = specifier.split("/");
    return `${parts[0]}/${parts[1]}`;
  }
  return specifier.split("/")[0]!;
}

/**
 * Extract all module specifiers from a JS/TS source string.
 * Handles:
 *   - static import/export … from 'x'
 *   - dynamic import('x')
 *   - require('x')
 *   - import type … from 'x'
 */
function extractSpecifiers(source: string): string[] {
  const found = new Set<string>();

  // Static import / export: import ... from 'x', export ... from 'x'
  // Also matches: import type { X } from 'x'
  const staticRe = /\b(?:import|export)\b(?:\s+type\b)?[^'";\n]*?['"]([^'"]+)['"]/g;
  // Dynamic import: import('x') or import("x")
  const dynamicRe = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  // CommonJS require: require('x')
  const requireRe = /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

  for (const re of [staticRe, dynamicRe, requireRe]) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(source)) !== null) {
      const raw = m[1]!;
      // Relative paths and absolute paths are not npm packages
      if (!raw || raw.startsWith(".") || raw.startsWith("/")) continue;
      found.add(raw);
    }
  }
  return Array.from(found);
}

interface PackageJson {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

/**
 * Scan all JS/TS workspace files and return external npm package names that are
 * imported but not declared in package.json's dependency fields.
 *
 * Returns an empty array when:
 *  - `files` contains no package.json
 *  - package.json is malformed JSON
 *  - all imports are accounted for
 */
export function scanMissingDeps(files: DepScanFile[]): string[] {
  const pkgFile = files.find((f) => f.path === "package.json");
  if (!pkgFile) return [];

  let pkg: PackageJson;
  try {
    pkg = JSON.parse(pkgFile.content) as PackageJson;
  } catch {
    return [];
  }

  const declared = new Set<string>([
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.devDependencies ?? {}),
    ...Object.keys(pkg.peerDependencies ?? {}),
    ...Object.keys(pkg.optionalDependencies ?? {}),
  ]);

  const sourceRe = /\.(js|jsx|ts|tsx|mjs|cjs)$/;
  const missing = new Set<string>();

  for (const f of files) {
    if (!sourceRe.test(f.path)) continue;
    for (const specifier of extractSpecifiers(f.content)) {
      const name = toPackageName(specifier);
      if (name && !isBuiltin(name) && !declared.has(name)) {
        missing.add(name);
      }
    }
  }

  return Array.from(missing).sort();
}

/**
 * Return an updated package.json string with `missing` packages injected into
 * `dependencies` as `"*"` (letting npm resolve the latest compatible version).
 *
 * - Already-declared entries are not overwritten.
 * - If JSON parsing fails the original string is returned unchanged.
 * - Indented with 2 spaces to match standard npm output.
 */
export function addMissingToDeps(packageJsonContent: string, missing: string[]): string {
  if (missing.length === 0) return packageJsonContent;
  let pkg: Record<string, unknown>;
  try {
    pkg = JSON.parse(packageJsonContent) as Record<string, unknown>;
  } catch {
    return packageJsonContent;
  }
  const deps = (pkg.dependencies ?? {}) as Record<string, string>;
  let changed = false;
  for (const name of missing) {
    if (!(name in deps)) {
      deps[name] = "*";
      changed = true;
    }
  }
  if (!changed) return packageJsonContent;
  pkg.dependencies = deps;
  return JSON.stringify(pkg, null, 2);
}
