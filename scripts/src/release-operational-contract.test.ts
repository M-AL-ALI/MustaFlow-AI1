import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const rootPackage = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
) as { scripts: Record<string, string> };
const scriptsPackage = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as { scripts: Record<string, string> };
const apiPackage = JSON.parse(
  readFileSync(new URL("../../artifacts/api-server/package.json", import.meta.url), "utf8"),
) as { scripts: Record<string, string> };
const gateSource = readFileSync(new URL("./ora-stability-gate.ts", import.meta.url), "utf8");
const apiVitestConfigSource = readFileSync(
  new URL("../../artifacts/api-server/vitest.config.ts", import.meta.url),
  "utf8",
);
const gateDocsSource = readFileSync(
  new URL("../../docs/ora-stability-gate.md", import.meta.url),
  "utf8",
);
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
const oraStabilityWorkflowSource = readFileSync(
  new URL("../../.github/workflows/ora-stability-gate.yml", import.meta.url),
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
  rootPackage.scripts["test:api:database"],
  "pnpm --filter @workspace/api-server run test:database",
);
assert.ok(
  apiPackage.scripts["test:database"].includes("NABUFLOW_VITEST_DATABASE_URL"),
  "database test entry point must require the dedicated disposable target",
);
for (const vitestDatabaseGuard of [
  "process.env.DATABASE_URL?.trim()",
  "!process.env.NABUFLOW_VITEST_DATABASE_URL?.trim()",
  "DATABASE_URL is not accepted by Vitest",
]) {
  assert.ok(
    apiVitestConfigSource.includes(vitestDatabaseGuard),
    `missing generic database fail-closed guard: ${vitestDatabaseGuard}`,
  );
}
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
  "git --no-optional-locks diff --name-only refs/remotes/origin/main..HEAD",
  "/^artifacts\\/mustaflow\\/src\\/pages\\/(?:.*\\/)?ora(?:x)?(?:[-./]|$)/i",
  "/^artifacts\\/mustaflow\\/src\\/pages\\/projects\\/components\\/(?:collaboration-card|project-collaboration)/i",
  "/project-collaboration/i",
  "/phase5\\.test\\.ts$/i",
]) {
  assert.ok(
    gateSource.includes(requiredRegistryGuard),
    `missing feature-registry path guard: ${requiredRegistryGuard}`,
  );
}

assert.equal(
  gateSource.includes('process.env.DATABASE_URL ?? "postgresql://ora_gate'),
  false,
  "the release gate must never invent or forward an ambient database target",
);
for (const databaseGuard of [
  "ORA_STABILITY_GATE_DATABASE_URL",
  "NABUFLOW_VITEST_DATABASE_URL",
  "/^ora_gate_disposable_[a-f0-9]{16}$/u",
  'url.hostname !== "127.0.0.1"',
  'databaseMode?: "import-only" | "required"',
  "127.0.0.1:1/ora_gate_import_only",
  "The gate never forwards ambient DATABASE_URL into mutating tests.",
  "Release database coverage is mandatory",
  'SKIP_DYNAMIC_PRERENDER: process.env.SKIP_DYNAMIC_PRERENDER ?? "1"',
]) {
  assert.ok(gateSource.includes(databaseGuard), `missing release database guard: ${databaseGuard}`);
}
const releaseDatabaseGroup = gateSource.match(
  /const API_RELEASE_DATABASE = \[([\s\S]*?)\]\.join\(" "\);/u,
)?.[1];
assert.ok(releaseDatabaseGroup, "missing isolated release database group");
for (const databaseTest of [
  "src/lib/__tests__/ora-assets-r2.test.ts",
  "src/lib/__tests__/ora-builder-isolation.test.ts",
  "src/routes/__tests__/admin-support-note.test.ts",
  "src/routes/__tests__/ora-image-edit.test.ts",
  "src/routes/__tests__/ora-assets.test.ts",
  "src/routes/__tests__/ora-conversation-persistence.test.ts",
  "src/routes/__tests__/ora-support-surface-isolation.test.ts",
  "src/routes/__tests__/ora-project-spaces.test.ts",
  "src/routes/__tests__/ora-account-consistency.test.ts",
  "src/routes/__tests__/ora-memory-enhancements.test.ts",
  "src/routes/__tests__/ora-memory-upgrades.test.ts",
  "src/lib/public-ai/__tests__/ora-realtime-usage.test.ts",
  "src/routes/__tests__/ora-memory-consolidation.test.ts",
  "src/routes/__tests__/support-ticket-ownership-isolation.test.ts",
]) {
  assert.ok(
    releaseDatabaseGroup.includes(databaseTest),
    `missing database-only test: ${databaseTest}`,
  );
  assert.equal(
    gateSource.slice(0, gateSource.indexOf("const API_RELEASE_DATABASE")).includes(databaseTest),
    false,
    `database-only test leaked into an unconditional release group: ${databaseTest}`,
  );
}

const missingDatabaseBranch = gateSource.match(
  /if \(check\.databaseMode === "required" && !configuredDatabaseUrl\) \{([\s\S]*?)\n  \}/u,
)?.[1];
assert.ok(missingDatabaseBranch, "missing mandatory release database branch");
assert.ok(
  missingDatabaseBranch.includes('status: "fail"'),
  "missing release database configuration must fail instead of warn",
);
for (const workflowGuard of [
  "POSTGRES_DB: ora_gate_disposable_0123456789abcdef",
  "DATABASE_URL: postgresql://postgres:postgres@127.0.0.1:5432/ora_gate_disposable_0123456789abcdef",
  "ORA_STABILITY_GATE_DATABASE_URL: postgresql://postgres:postgres@127.0.0.1:5432/ora_gate_disposable_0123456789abcdef",
  "-d ora_gate_disposable_0123456789abcdef",
]) {
  assert.ok(
    oraStabilityWorkflowSource.includes(workflowGuard),
    `missing disposable release database workflow guard: ${workflowGuard}`,
  );
}
assert.equal(
  oraStabilityWorkflowSource.includes("mustaflow_gate"),
  false,
  "stability workflow must not target an obsolete database",
);

for (const checkpointGuard of [
  "ora-stability-gate-checkpoint-v1",
  "--max-checks requires --checkpoint",
  "--checkpoint requires --require-clean",
  "Release checkpoint path must be outside the repository",
  "Release checkpoint identity does not match this gate invocation",
  "Release checkpoint completed checks are not an ordered prefix",
  "[ora-gate] CHECKPOINTED:",
  "[ora-gate] INCOMPLETE:",
  'results.some((result) => result.status === "fail") ? 1 : 75',
  "process.exitCode = incompleteExitCode",
  "renameSync(temporary, absolute)",
]) {
  assert.ok(gateSource.includes(checkpointGuard), `missing checkpoint guard: ${checkpointGuard}`);
}
for (const checkpointDocumentation of [
  "return exit code `75`",
  "fail-fast checkpoint containing a failed check returns `1`",
  "Automation must treat both codes as not approved",
]) {
  assert.ok(
    gateDocsSource.includes(checkpointDocumentation),
    `missing checkpoint exit-code documentation: ${checkpointDocumentation}`,
  );
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
