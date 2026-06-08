/**
 * Bundle size guard — fails the build when the initial JS payload for any
 * entry exceeds Google's 2 MB rendering limit.
 *
 * How it works:
 *  1. Reads the Vite-generated .vite/manifest.json from dist/public/.
 *  2. For each entry chunk (isEntry: true), walks the full transitive
 *     synchronous import graph (entry → imports → their imports, etc.)
 *     using a breadth-first traversal.
 *  3. Sums uncompressed byte sizes of all .js/.mjs files in that graph.
 *  4. Fails with exit code 1 if any entry's total exceeds BUDGET_BYTES.
 *
 * Run automatically after every `pnpm build` via the `postbuild` script.
 */

import { readFileSync, statSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST_DIR = join(__dirname, "..", "dist", "public");
const MANIFEST_PATH = join(DIST_DIR, ".vite", "manifest.json");

const BUDGET_BYTES = 2 * 1024 * 1024; // 2 MB — Google's JS rendering limit
const WARN_BYTES = 1.5 * 1024 * 1024; // 1.5 MB — warn early

function bytesToKB(n) {
  return (n / 1024).toFixed(1);
}

let manifest;
try {
  manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf-8"));
} catch {
  console.warn("[bundle-size] No manifest found — skipping check (run `pnpm build` first).");
  process.exit(0);
}

// Build a lookup: file path → manifest chunk entry
const byFile = new Map();
for (const chunk of Object.values(manifest)) {
  if (chunk.file) byFile.set(chunk.file, chunk);
}

/**
 * Walk the full transitive synchronous import graph for a given chunk.
 * Returns a Set of all .js/.mjs file paths reachable from the entry.
 */
function collectInitialFiles(entryChunk) {
  const visited = new Set();
  const queue = [entryChunk];

  while (queue.length > 0) {
    const chunk = queue.shift();
    if (!chunk || !chunk.file) continue;
    if (visited.has(chunk.file)) continue;
    visited.add(chunk.file);

    for (const imp of chunk.imports ?? []) {
      // imports can be either a file path or a manifest key
      const imported = byFile.get(imp) ?? manifest[imp];
      if (imported && !visited.has(imported.file)) {
        queue.push(imported);
      }
    }
  }

  return visited;
}

const chunks = Object.values(manifest);
const entryChunks = chunks.filter((c) => c.isEntry);

if (entryChunks.length === 0) {
  console.warn("[bundle-size] No entry chunks found in manifest — skipping check.");
  process.exit(0);
}

let failed = false;

for (const entry of entryChunks) {
  const initialFiles = collectInitialFiles(entry);

  let totalBytes = 0;
  const details = [];

  for (const file of initialFiles) {
    if (!file.endsWith(".js") && !file.endsWith(".mjs")) continue;
    const absPath = join(DIST_DIR, file);
    let size = 0;
    try {
      size = statSync(absPath).size;
    } catch {
      continue;
    }
    totalBytes += size;
    details.push({ file, size });
  }

  const label = entry.file ?? entry.src ?? "unknown";
  details.sort((a, b) => b.size - a.size);

  const icon = totalBytes > BUDGET_BYTES ? "✖" : totalBytes > WARN_BYTES ? "⚠" : "✔";
  console.log(
    `[bundle-size] ${icon} Entry: ${label}  initial JS = ${bytesToKB(totalBytes)} kB / budget ${bytesToKB(BUDGET_BYTES)} kB`,
  );
  for (const { file, size } of details.slice(0, 10)) {
    console.log(`             ${bytesToKB(size).padStart(8)} kB  ${file}`);
  }
  if (details.length > 10) {
    console.log(`             … and ${details.length - 10} more chunks`);
  }

  if (totalBytes > BUDGET_BYTES) {
    console.error(
      `[bundle-size] ✖ FAIL: entry "${label}" initial JS (${bytesToKB(totalBytes)} kB) ` +
        `exceeds the ${bytesToKB(BUDGET_BYTES)} kB budget.\n` +
        `       Split auth-gated and public routes so crawlers see a lighter entry.`,
    );
    failed = true;
  } else if (totalBytes > WARN_BYTES) {
    console.warn(
      `[bundle-size] ⚠ WARN: entry "${label}" initial JS (${bytesToKB(totalBytes)} kB) ` +
        `is approaching the ${bytesToKB(BUDGET_BYTES)} kB budget.`,
    );
  }
}

if (failed) {
  process.exit(1);
}

console.log("[bundle-size] All entries within budget.");
