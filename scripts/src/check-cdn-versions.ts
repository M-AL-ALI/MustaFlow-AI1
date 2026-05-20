/**
 * check-cdn-versions.ts
 *
 * Fetches the latest stable version for each CDN_ALLOWLIST package from the
 * npm registry and flags entries where `minimumRecommendedVersion` is behind
 * by at least one major or minor version (patch-only differences are ignored).
 *
 * Usage: pnpm --filter @workspace/scripts run check-cdn-versions
 */

import { CDN_ALLOWLIST } from "../../artifacts/api-server/src/lib/cdn-allowlist.js";

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

async function main() {
  console.log("Checking CDN allowlist package versions against npm registry…\n");

  let driftCount = 0;
  let errorCount = 0;
  let checkedCount = 0;

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
      console.log(
        `  DRIFT ${entry.displayName} (${npmPackage})\n` +
          `        minimumRecommendedVersion = ${entry.minimumRecommendedVersion}\n` +
          `        latest stable             = ${latest}\n` +
          `        → Update cdn-allowlist.ts to bump minimumRecommendedVersion to ${latest}`,
      );
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

  if (driftCount > 0) {
    console.log(
      "\nAction required: update `minimumRecommendedVersion` in\n" +
        "  artifacts/api-server/src/lib/cdn-allowlist.ts\n" +
        "for each DRIFT entry above, then re-run this script to confirm.",
    );
    process.exit(1);
  }
}

main();
