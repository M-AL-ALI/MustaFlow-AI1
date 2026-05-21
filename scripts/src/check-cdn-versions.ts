/**
 * check-cdn-versions.ts
 *
 * Fetches the latest stable version for each CDN_ALLOWLIST package from the
 * npm registry and flags entries where `minimumRecommendedVersion` is behind
 * by at least one major or minor version (patch-only differences are ignored).
 *
 * Usage:
 *   pnpm --filter @workspace/scripts run check-cdn-versions
 *   pnpm --filter @workspace/scripts run check-cdn-versions -- --fix
 *
 * --fix  Rewrites minimumRecommendedVersion in cdn-allowlist.ts for every
 *        drifted entry and prints a diff of what changed before writing.
 *        Blocked-version rules and CVE entries are never modified.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { CDN_ALLOWLIST } from "../../artifacts/api-server/src/lib/cdn-allowlist.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const ALLOWLIST_PATH = path.resolve(
  __dirname,
  "../../artifacts/api-server/src/lib/cdn-allowlist.ts",
);

/**
 * Maps allowlist `name` values to their actual npm package names where they differ.
 * Keys that are absent from this map are assumed to be identical to their npm package name.
 */
const NPM_NAME_OVERRIDES: Record<string, string> = {
  chartjs: "chart.js",
  htmx: "htmx.org",
};

/** Parse a semver string into [major, minor, patch] numeric parts. */
function parseSemver(version: string): [number, number, number] {
  const cleaned = version.replace(/^[^0-9]*/, "");
  const parts = cleaned.split(".").map((p) => parseInt(p, 10) || 0);
  return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0];
}

/**
 * Returns true when `current` is behind `latest` by at least one major or minor
 * version (patch-only differences are intentionally ignored).
 */
function isMinorOrMajorBehind(current: string, latest: string): boolean {
  const [curMaj, curMin] = parseSemver(current);
  const [latMaj, latMin] = parseSemver(latest);
  if (latMaj > curMaj) return true;
  if (latMaj === curMaj && latMin > curMin) return true;
  return false;
}

async function fetchLatestVersion(npmPackage: string): Promise<string | null> {
  const url = `https://registry.npmjs.org/${encodeURIComponent(npmPackage)}/latest`;
  try {
    const res = await fetch(url);
    if (!res.ok) {
      console.error(`  [WARN] registry returned ${res.status} for ${npmPackage}`);
      return null;
    }
    const data = (await res.json()) as { version?: string };
    return data.version ?? null;
  } catch (err) {
    console.error(`  [ERROR] failed to fetch ${npmPackage}: ${(err as Error).message}`);
    return null;
  }
}

/**
 * Replace the minimumRecommendedVersion for a specific entry (identified by its
 * `name` field) inside the cdn-allowlist.ts source text.
 *
 * The regex matches from `name: "entryName"` (non-greedy) to the first
 * `minimumRecommendedVersion:` that follows within the same object, replacing
 * only the quoted version string. Blocked-version rules and CVE entries are
 * never touched because they don't contain `minimumRecommendedVersion`.
 */
function patchAllowlistSource(source: string, entryName: string, newVersion: string): string {
  // Escape the entry name for use inside a regex literal
  const escapedName = entryName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(
    `(name:\\s*"${escapedName}"[\\s\\S]*?minimumRecommendedVersion:\\s*")[^"]+(")`,
  );
  return source.replace(pattern, `$1${newVersion}$2`);
}

/**
 * Produce a human-readable unified-style diff for changed lines.
 * Only lines that differ between `before` and `after` are shown, with
 * ±3 lines of surrounding context.
 */
function diffLines(before: string, after: string): string {
  const bLines = before.split("\n");
  const aLines = after.split("\n");
  const CONTEXT = 3;
  const output: string[] = [];

  // Collect indices where lines differ
  const changedIndices = new Set<number>();
  const maxLen = Math.max(bLines.length, aLines.length);
  for (let i = 0; i < maxLen; i++) {
    if (bLines[i] !== aLines[i]) changedIndices.add(i);
  }

  if (changedIndices.size === 0) return "(no changes)";

  // Expand changed indices with context window
  const shownIndices = new Set<number>();
  for (const idx of changedIndices) {
    for (let c = idx - CONTEXT; c <= idx + CONTEXT; c++) {
      if (c >= 0 && c < maxLen) shownIndices.add(c);
    }
  }

  let lastIdx = -2;
  for (const idx of [...shownIndices].sort((a, b) => a - b)) {
    if (idx > lastIdx + 1) output.push("  ...");
    const bLine = bLines[idx];
    const aLine = aLines[idx];
    if (changedIndices.has(idx)) {
      if (bLine !== undefined) output.push(`- ${bLine}`);
      if (aLine !== undefined) output.push(`+ ${aLine}`);
    } else {
      output.push(`  ${bLine ?? aLine ?? ""}`);
    }
    lastIdx = idx;
  }

  return output.join("\n");
}

interface DriftEntry {
  entryName: string;
  displayName: string;
  oldVersion: string;
  newVersion: string;
}

async function main() {
  const fixMode = process.argv.includes("--fix");

  console.log(
    `Checking CDN allowlist package versions against npm registry…${fixMode ? " (--fix mode)" : ""}\n`,
  );

  let driftCount = 0;
  let errorCount = 0;
  let checkedCount = 0;
  const driftEntries: DriftEntry[] = [];

  for (const entry of CDN_ALLOWLIST) {
    if (!entry.minimumRecommendedVersion) {
      console.log(
        `  SKIP  ${entry.displayName} (${entry.name}) — no minimumRecommendedVersion set`,
      );
      continue;
    }

    const npmPackage = NPM_NAME_OVERRIDES[entry.name] ?? entry.name;
    const latest = await fetchLatestVersion(npmPackage);

    if (latest === null) {
      errorCount++;
      console.log(`  SKIP  ${entry.displayName} (${npmPackage}) — could not fetch`);
      continue;
    }

    checkedCount++;
    const behind = isMinorOrMajorBehind(entry.minimumRecommendedVersion, latest);

    if (behind) {
      driftCount++;
      driftEntries.push({
        entryName: entry.name,
        displayName: entry.displayName,
        oldVersion: entry.minimumRecommendedVersion,
        newVersion: latest,
      });
      console.log(
        `  DRIFT ${entry.displayName} (${npmPackage})\n` +
          `        minimumRecommendedVersion = ${entry.minimumRecommendedVersion}\n` +
          `        latest stable             = ${latest}`,
      );
      if (!fixMode) {
        console.log(
          `        → Update cdn-allowlist.ts to bump minimumRecommendedVersion to ${latest}`,
        );
      }
    } else {
      console.log(
        `  OK    ${entry.displayName} (${npmPackage}) — allowlist ${entry.minimumRecommendedVersion} vs latest ${latest}`,
      );
    }
  }

  console.log(
    `\nDone. ${checkedCount} packages checked, ` +
      `${driftCount} drift(s) found, ${errorCount} fetch error(s).`,
  );

  if (driftCount === 0) return;

  if (!fixMode) {
    console.log(
      "\nAction required: update `minimumRecommendedVersion` in\n" +
        "  artifacts/api-server/src/lib/cdn-allowlist.ts\n" +
        "for each DRIFT entry above, then re-run this script to confirm.\n" +
        "\nTip: re-run with --fix to apply the bumps automatically:",
    );
    console.log("  pnpm --filter @workspace/scripts run check-cdn-versions -- --fix");
    process.exit(1);
  }

  // --fix: apply the version bumps
  console.log("\nApplying fixes to cdn-allowlist.ts…\n");

  const source = fs.readFileSync(ALLOWLIST_PATH, "utf-8");
  let patched = source;

  for (const drift of driftEntries) {
    const before = patched;
    patched = patchAllowlistSource(patched, drift.entryName, drift.newVersion);

    if (patched === before) {
      console.warn(
        `  [WARN] Could not locate minimumRecommendedVersion for "${drift.entryName}" — skipped.`,
      );
      continue;
    }

    console.log(`  PATCH ${drift.displayName}: ${drift.oldVersion} → ${drift.newVersion}`);
    console.log(diffLines(before, patched));
    console.log();
  }

  if (patched === source) {
    console.log("No changes written (all patches failed to locate their targets).");
    process.exit(1);
  }

  fs.writeFileSync(ALLOWLIST_PATH, patched, "utf-8");
  console.log(`\nWrote updated allowlist to:\n  ${ALLOWLIST_PATH}`);
  console.log("\nRe-run without --fix to confirm all drift is resolved.");
}

main();
