/**
 * Bundle size guard — fails the build when the public entry's initial JS
 * payload exceeds Google's 2 MB rendering limit.
 *
 * Strategy: parse the built `dist/public/public.html` (the lightweight public
 * entry) and collect every `<link rel="modulepreload">` href. Those are
 * exactly the JS files a browser loads synchronously before executing the
 * entry point — the same set crawlers must execute to see content.
 * Sum uncompressed bytes; fail if > BUDGET_BYTES.
 *
 * Fallback (manifest): if `public.html` is absent (dev-only builds) the tool
 * falls back to walking `dist/public/.vite/manifest.json` for the public
 * entry's transitive import graph.
 *
 * Run automatically after every `pnpm build` via the `postbuild` script.
 */

import { readFileSync, statSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST_DIR = join(__dirname, "..", "dist", "public");

const BUDGET_BYTES = 2 * 1024 * 1024; // 2 MB — Google's JS rendering limit
const WARN_BYTES = 1.5 * 1024 * 1024; // 1.5 MB — early warning threshold
const WORKSPACE_SYNC_IMPORT_BUDGET = 24;

function bytesToKB(n) {
  return (n / 1024).toFixed(1);
}

function fileSize(absPath) {
  try {
    return statSync(absPath).size;
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Strategy A: parse <link rel="modulepreload"> from the built public.html
// ---------------------------------------------------------------------------
function checkViaHtml() {
  const htmlPath = join(DIST_DIR, "public.html");
  if (!existsSync(htmlPath)) return null; // signal: try fallback

  const html = readFileSync(htmlPath, "utf-8");

  // Match all <link rel="modulepreload" href="..."> (Vite emits these)
  const re = /<link[^>]+rel=["']modulepreload["'][^>]+href=["']([^"']+)["'][^>]*>/gi;
  const files = [];
  let m;
  while ((m = re.exec(html)) !== null) {
    const href = m[1];
    if (!href.endsWith(".js") && !href.endsWith(".mjs")) continue;
    // Vite hrefs are root-relative (e.g. /assets/foo.js or /base/assets/foo.js).
    // Anchor on the /assets/ segment so both root and base-prefixed hrefs resolve
    // to a path relative to DIST_DIR. (The old `/^\/[^/]*\//` regex wrongly
    // stripped the `assets/` dir itself for root paths, producing 0-byte sizes
    // and a false-green budget check.)
    const assetsIdx = href.indexOf("/assets/");
    const rel = assetsIdx >= 0 ? href.slice(assetsIdx + 1) : href.replace(/^\//, "");
    files.push({ href, rel });
  }

  if (files.length === 0) {
    console.warn(
      "[bundle-size] No <link rel=modulepreload> found in public.html — skipping size check.",
    );
    return { skipped: true };
  }

  let totalBytes = 0;
  const details = [];
  for (const { href, rel } of files) {
    const absPath = join(DIST_DIR, rel);
    const size = fileSize(absPath);
    totalBytes += size;
    details.push({ file: rel || href, size });
  }

  // Guard against a silent false-green: if we matched preload links but every
  // one resolved to 0 bytes, the href→file mapping is broken (not a genuinely
  // empty bundle). Surface it instead of reporting a bogus pass.
  if (files.length > 0 && totalBytes === 0) {
    console.error(
      `[bundle-size] ✖ FAIL: matched ${files.length} preload link(s) in public.html but ` +
        `all resolved to 0 bytes — href→file path mapping is broken. ` +
        `Check the /assets/ normalization in check-bundle-size.mjs.`,
    );
    process.exit(1);
  }

  return { totalBytes, details, method: "html-modulepreload" };
}

// ---------------------------------------------------------------------------
// Strategy B: walk the Vite manifest for the public entry (fallback)
// ---------------------------------------------------------------------------
function checkViaManifest() {
  const manifestPath = join(DIST_DIR, ".vite", "manifest.json");
  if (!existsSync(manifestPath)) return null;

  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
  } catch {
    return null;
  }

  // Find the public entry chunk
  const entryChunk = Object.values(manifest).find(
    (c) => c.isEntry && (c.src?.includes("public-main") || c.src?.includes("public.html")),
  );
  if (!entryChunk) {
    // Second try: any entry whose file is referenced by public.html
    return null;
  }

  // BFS over the synchronous import graph
  const byFile = new Map();
  for (const chunk of Object.values(manifest)) {
    if (chunk.file) byFile.set(chunk.file, chunk);
  }

  const visited = new Set();
  const queue = [entryChunk];
  while (queue.length > 0) {
    const chunk = queue.shift();
    if (!chunk?.file || visited.has(chunk.file)) continue;
    visited.add(chunk.file);
    for (const imp of chunk.imports ?? []) {
      const dep = byFile.get(imp) ?? manifest[imp];
      if (dep && !visited.has(dep.file)) queue.push(dep);
    }
  }

  let totalBytes = 0;
  const details = [];
  for (const file of visited) {
    if (!file.endsWith(".js") && !file.endsWith(".mjs")) continue;
    const size = fileSize(join(DIST_DIR, file));
    totalBytes += size;
    details.push({ file, size });
  }

  return { totalBytes, details, method: "manifest" };
}

function checkWorkspaceImportFanout() {
  const manifestPath = join(DIST_DIR, ".vite", "manifest.json");
  if (!existsSync(manifestPath)) {
    console.error("[bundle-size] ✖ FAIL: Vite manifest missing; workspace fan-out is unverified.");
    process.exit(1);
  }

  const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
  const candidates = Object.values(manifest).filter(
    (chunk) => chunk.isDynamicEntry && chunk.name === "_id_",
  );
  if (candidates.length !== 1) {
    console.error(
      `[bundle-size] ✖ FAIL: expected one project-workspace entry, found ${candidates.length}.`,
    );
    process.exit(1);
  }

  const synchronousImports = candidates[0].imports?.length ?? 0;
  console.log(
    `[bundle-size] Project workspace synchronous imports = ${synchronousImports} / budget ${WORKSPACE_SYNC_IMPORT_BUDGET}.`,
  );
  if (synchronousImports > WORKSPACE_SYNC_IMPORT_BUDGET) {
    console.error(
      `[bundle-size] ✖ FAIL: project workspace would request ${synchronousImports} synchronous chunks. ` +
        `Coalesce acyclic leaf modules before publishing to avoid production edge throttling.`,
    );
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
const result = checkViaHtml() ?? checkViaManifest();

if (!result) {
  console.warn(
    "[bundle-size] Neither dist/public/public.html nor .vite/manifest.json found — " +
      "skipping check (run `pnpm build` first).",
  );
  process.exit(0);
}

if (result.skipped) {
  process.exit(0);
}

checkWorkspaceImportFanout();

const { totalBytes, details, method } = result;

details.sort((a, b) => b.size - a.size);

const icon = totalBytes > BUDGET_BYTES ? "✖" : totalBytes > WARN_BYTES ? "⚠" : "✔";
console.log(
  `[bundle-size] ${icon} public entry initial JS = ${bytesToKB(totalBytes)} kB / budget ${bytesToKB(BUDGET_BYTES)} kB  (via ${method})`,
);
for (const { file, size } of details.slice(0, 12)) {
  console.log(`             ${bytesToKB(size).padStart(8)} kB  ${file}`);
}
if (details.length > 12) {
  console.log(`             … and ${details.length - 12} more preloaded files`);
}

if (totalBytes > BUDGET_BYTES) {
  console.error(
    `\n[bundle-size] ✖ FAIL: public entry initial JS (${bytesToKB(totalBytes)} kB) exceeds ` +
      `the ${bytesToKB(BUDGET_BYTES)} kB budget.\n` +
      `       Split auth-gated code so crawlers receive a lighter entry.\n` +
      `       Top chunks above ↑`,
  );
  process.exit(1);
}

if (totalBytes > WARN_BYTES) {
  console.warn(
    `[bundle-size] ⚠ WARN: public entry (${bytesToKB(totalBytes)} kB) is approaching ` +
      `the ${bytesToKB(BUDGET_BYTES)} kB limit.`,
  );
}

console.log("[bundle-size] Public entry within budget.");
