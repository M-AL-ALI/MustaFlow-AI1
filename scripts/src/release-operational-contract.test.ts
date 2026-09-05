import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const rootPackage = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
) as { scripts: Record<string, string> };
const scriptsPackage = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as { scripts: Record<string, string> };
const gateSource = readFileSync(new URL("./ora-stability-gate.ts", import.meta.url), "utf8");
const drizzleConfigSource = readFileSync(
  new URL("../../lib/db/drizzle.config.ts", import.meta.url),
  "utf8",
);
const oraMobileBuildSource = readFileSync(
  new URL("../../artifacts/ora-mobile/scripts/build.js", import.meta.url),
  "utf8",
);
const dynamicPrerenderSource = readFileSync(
  new URL("./prerender-dynamic-routes.ts", import.meta.url),
  "utf8",
);

assert.equal(
  rootPackage.scripts["test:api:serial"],
  "pnpm --filter @workspace/api-server exec vitest run --no-file-parallelism",
);
assert.equal(
  rootPackage.scripts["test:web:serial"],
  "pnpm --filter @workspace/mustaflow exec vitest run --config vitest.config.ts --no-file-parallelism",
);
assert.equal(
  rootPackage.scripts["release:verify-production"],
  "pnpm --filter @workspace/scripts run verify:production-release",
);
assert.equal(
  scriptsPackage.scripts["verify:production-release"],
  "tsx ./src/verify-production-release.ts",
);
assert.equal(gateSource.includes("--minWorkers"), false);
assert.ok(
  drizzleConfigSource.includes('.replaceAll("\\\\", "/")'),
  "Drizzle schema paths must use portable separators so a Windows lab can bootstrap its test database",
);
assert.equal(
  gateSource.includes("/^artifacts\\/mustaflow\\/src\\/pages\\/.*ora/i"),
  false,
  "Ora file discovery must not match unrelated words such as collaboration",
);
assert.ok(
  oraMobileBuildSource.includes("process.env.npm_execpath") &&
    oraMobileBuildSource.includes("process.env.npm_node_execpath || process.execPath"),
  "Ora mobile builds must launch Metro through the inherited pnpm entry point",
);
assert.equal(
  oraMobileBuildSource.includes('spawn("pnpm"'),
  false,
  "Ora mobile builds must not use the non-portable Windows pnpm shim directly",
);
assert.ok(
  oraMobileBuildSource.includes(
    'spawnSync(taskkillPath, ["/pid", String(current.pid), "/t", "/f"]',
  ),
  "Ora mobile builds must terminate the complete Metro process tree on Windows",
);
assert.equal(
  oraMobileBuildSource.includes("metroProcess.kill("),
  false,
  "Ora mobile shutdown paths must use the process-tree cleanup coordinator",
);
assert.equal(
  dynamicPrerenderSource.includes('import { pool } from "@workspace/db"'),
  false,
  "dynamic prerender must not load the database before its DATABASE-less CI gate",
);
assert.ok(
  dynamicPrerenderSource.indexOf('process.env.SKIP_DYNAMIC_PRERENDER === "1"') <
    dynamicPrerenderSource.indexOf('await import("@workspace/db")'),
  "dynamic prerender must evaluate the explicit skip gate before loading the database",
);
for (const requiredRegistryGuard of [
  "/^artifacts\\/mustaflow\\/src\\/pages\\/(?:.*\\/)?ora(?:x)?(?:[-./]|$)/i",
  "/^artifacts\\/mustaflow\\/src\\/pages\\/projects\\/components\\/(?:collaboration-card|project-collaboration)/i",
  "/project-collaboration/i",
]) {
  assert.ok(
    gateSource.includes(requiredRegistryGuard),
    `missing feature-registry path guard: ${requiredRegistryGuard}`,
  );
}

for (const checkpointGuard of [
  "ora-stability-gate-checkpoint-v1",
  "--max-checks requires --checkpoint",
  "--checkpoint requires --require-clean",
  "Release checkpoint path must be outside the repository",
  "Release checkpoint identity does not match this gate invocation",
  "Release checkpoint completed checks are not an ordered prefix",
  "[ora-gate] CHECKPOINTED:",
  "renameSync(temporary, absolute)",
]) {
  assert.ok(gateSource.includes(checkpointGuard), `missing checkpoint guard: ${checkpointGuard}`);
}

const vitestCommands = [...gateSource.matchAll(/command:\s*(?:`([^`]*)`|"([^"]*)")/gs)]
  .map((match) => match[1] ?? match[2] ?? "")
  .filter((command) => command.includes("vitest run"));
assert.ok(vitestCommands.length > 0);
for (const command of vitestCommands) {
  assert.ok(command.includes("--no-file-parallelism"), `non-serial command: ${command}`);
}

for (const required of [
  "src/lib/builder-chunk-recovery.test.ts",
  "src/components/builder-chunk-error-boundary.test.tsx",
]) {
  assert.ok(gateSource.includes(required), `missing release guard: ${required}`);
}

process.stdout.write(
  `release operational contract: PASS (${vitestCommands.length} serial Vitest commands)\n`,
);
