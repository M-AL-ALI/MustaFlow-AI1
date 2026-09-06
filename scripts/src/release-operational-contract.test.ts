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
const migrationCoordinatorSource = readFileSync(
  new URL("./migrate-all-outstanding.ts", import.meta.url),
  "utf8",
);
const oraAssetSchemaSource = readFileSync(
  new URL("../../lib/db/src/schema/ora-assets.ts", import.meta.url),
  "utf8",
);
const oraAssetStorageMigrationSource = readFileSync(
  new URL("./migrate-ora-asset-storage.ts", import.meta.url),
  "utf8",
);
const oraAssetReferenceGuardMigrationSource = readFileSync(
  new URL("./migrate-ora-asset-reference-guards.ts", import.meta.url),
  "utf8",
);
const startupMigrationRunnerSource = readFileSync(
  new URL("./run-startup-migrations.ts", import.meta.url),
  "utf8",
);
const productionReleaseCliSource = readFileSync(
  new URL("./verify-production-release.ts", import.meta.url),
  "utf8",
);
const cloudflareRuntimeReleaseVerifierSource = readFileSync(
  new URL("./cloudflare-runtime-release-verifier.ts", import.meta.url),
  "utf8",
);
const runtimeProductionConfigSource = readFileSync(
  new URL(
    "../../artifacts/nabuflow-runtime-worker/wrangler.runtime.production.jsonc",
    import.meta.url,
  ),
  "utf8",
);
const replitSource = readFileSync(new URL("../../.replit", import.meta.url), "utf8");
const projectRoutesSource = readFileSync(
  new URL("../../artifacts/api-server/src/routes/projects.ts", import.meta.url),
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
assert.equal(
  scriptsPackage.scripts["migrate:startup:disposable"],
  "tsx ./src/run-startup-migrations.ts",
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
assert.ok(
  scriptsPackage.scripts["test:release-contracts"].includes(
    "cloudflare-runtime-release-verifier.test.ts",
  ),
  "Cloudflare runtime parity must remain part of the release contract suite",
);
for (const runtimeReleaseGuard of [
  "verifyCloudflareRuntimeRelease",
  "expectedCommit: receipt.version.commit",
  "expectedTree: receipt.version.tree",
]) {
  assert.ok(
    productionReleaseCliSource.includes(runtimeReleaseGuard),
    `missing Cloudflare runtime release guard: ${runtimeReleaseGuard}`,
  );
}
const epochBinding = "NABUFLOW_PRODUCTION_DATABASE_ADMISSION_EPOCH";
const runtimeEpoch = new RegExp(`"${epochBinding}"\\s*:\\s*"([^"]+)"`, "u").exec(
  runtimeProductionConfigSource,
)?.[1];
const replitProduction = replitSource.slice(replitSource.indexOf("[userenv.production]"));
const replitEpoch = new RegExp(`^${epochBinding}\\s*=\\s*"([^"]+)"`, "mu").exec(
  replitProduction,
)?.[1];
assert.match(runtimeEpoch ?? "", /^[0-9a-f-]{36}$/u);
assert.equal(
  replitEpoch,
  runtimeEpoch,
  "Replit and Cloudflare must share the exact admission epoch",
);
for (const databaseBinding of [
  epochBinding,
  "NABUFLOW_PRODUCTION_NEON_ORGANIZATION_ID",
  "NABUFLOW_PRODUCTION_NEON_REGION_ID",
  "NABUFLOW_PRODUCTION_NEON_HISTORY_RETENTION_SECONDS",
  "NABUFLOW_PRODUCTION_DATABASE_MAX_PROJECTS",
]) {
  assert.ok(
    cloudflareRuntimeReleaseVerifierSource.includes(databaseBinding),
    `release verification must require ${databaseBinding}`,
  );
}
for (const ownerOnlyAdmissionRoute of [
  '"/admin/production-database-admission"',
  "`/admin/production-database-admission/${action}`",
  "requireAdmin",
  "requireOwner",
]) {
  assert.ok(
    projectRoutesSource.includes(ownerOnlyAdmissionRoute),
    `missing owner-only admission route guard: ${ownerOnlyAdmissionRoute}`,
  );
}
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
  'databaseMode?: "required"',
  "The gate never forwards ambient DATABASE_URL into mutating tests.",
  "Release database coverage is mandatory",
  'SKIP_DYNAMIC_PRERENDER: process.env.SKIP_DYNAMIC_PRERENDER ?? "1"',
]) {
  assert.ok(gateSource.includes(databaseGuard), `missing release database guard: ${databaseGuard}`);
}
assert.equal(
  gateSource.includes("import-only"),
  false,
  "non-database gate checks must not receive a generic DATABASE_URL",
);
assert.ok(
  gateSource.includes("phase1\\.test\\.ts$/i"),
  "Phase 1 routing regressions must be owned by the feature registry",
);
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
  /if \(check\.databaseMode === "required" && !configuredDatabaseUrl\) \{([\s\S]*?)\n {2}\}/u,
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
assert.equal(
  [...oraStabilityWorkflowSource.matchAll(/run migrate:startup:disposable/g)].length,
  2,
  "release bootstrap must prove production startup migrations twice",
);
assert.ok(
  oraStabilityWorkflowSource.indexOf("run migrate-all-outstanding") <
    oraStabilityWorkflowSource.indexOf("run migrate:startup:disposable") &&
    oraStabilityWorkflowSource.indexOf("run migrate:startup:disposable") <
      oraStabilityWorkflowSource.indexOf("run ora-stability-gate"),
  "release bootstrap ordering must converge standalone and startup migrations before tests",
);
for (const startupRunnerGuard of [
  "resolveVitestDatabaseUrl(process.env)",
  "DATABASE_URL must exactly match the approved disposable database URL",
  "EXPECTED_STARTUP_MIGRATION_COUNT = 158",
  "result.failed !== 0",
  "result.passed !== EXPECTED_STARTUP_MIGRATION_COUNT",
  "await pool.end()",
]) {
  assert.ok(
    startupMigrationRunnerSource.includes(startupRunnerGuard),
    `missing disposable startup migration guard: ${startupRunnerGuard}`,
  );
}
assert.equal(
  startupMigrationRunnerSource.includes('import { pool } from "@workspace/db"'),
  false,
  "the disposable URL guard must run before the shared database pool is imported",
);

const migrationBlock = migrationCoordinatorSource.match(
  /export const MIGRATIONS = \[([\s\S]*?)\] as const;/u,
)?.[1];
const exclusionBlock = migrationCoordinatorSource.match(
  /export const MIGRATION_EXCLUSIONS = \{([\s\S]*?)\} as const;/u,
)?.[1];
assert.ok(migrationBlock, "missing governed migration list");
assert.ok(exclusionBlock, "missing governed migration exclusions");
const selectedMigrations = [...migrationBlock.matchAll(/^\s*"([^"]+)",\s*$/gmu)].map(
  (match) => match[1],
);
const excludedMigrations = [...exclusionBlock.matchAll(/^\s*"([^"]+)":\s*"([^"]+)",\s*$/gmu)].map(
  (match) => ({ name: match[1], reason: match[2] }),
);
const registeredMigrations = Object.keys(scriptsPackage.scripts)
  .filter((name) => name.startsWith("migrate-") && name !== "migrate-all-outstanding")
  .sort();
assert.equal(
  new Set(selectedMigrations).size,
  selectedMigrations.length,
  "automatic migration list contains duplicates",
);
assert.equal(
  new Set(excludedMigrations.map(({ name }) => name)).size,
  excludedMigrations.length,
  "governed migration exclusion list contains duplicates",
);
assert.deepEqual(
  excludedMigrations.map(({ name }) => name).sort(),
  ["migrate-drop-conversations", "migrate-drop-ora-daily-usage", "migrate-recover-ora-memories"],
  "only reviewed destructive or heuristic migrations may bypass automatic convergence",
);
for (const { name, reason } of excludedMigrations) {
  assert.ok(reason.length >= 20, `migration exclusion requires a durable reason: ${name}`);
  assert.equal(
    selectedMigrations.includes(name),
    false,
    `excluded migration also selected: ${name}`,
  );
}
assert.deepEqual(
  [...selectedMigrations, ...excludedMigrations.map(({ name }) => name)].sort(),
  registeredMigrations,
  "every registered migration must be selected or explicitly governed",
);
for (const migration of registeredMigrations) {
  assert.equal(
    scriptsPackage.scripts[migration],
    `tsx ./src/${migration}.ts`,
    `migration registration must resolve to its auditable source: ${migration}`,
  );
}
for (const sourceGuard of [
  'check("ora_assets_storage_xor"',
  'uniqueIndex("ora_assets_asset_id_uq")',
  ".where(sql`${t.assetId} IS NOT NULL`)",
]) {
  assert.ok(
    oraAssetSchemaSource.includes(sourceGuard),
    `missing Ora asset schema guard: ${sourceGuard}`,
  );
}
for (const migrationGuard of [
  "ora_assets_storage_xor",
  "CREATE UNIQUE INDEX IF NOT EXISTS ora_assets_asset_id_uq",
  "ON ora_assets(asset_id) WHERE asset_id IS NOT NULL",
]) {
  assert.ok(
    oraAssetStorageMigrationSource.includes(migrationGuard),
    `missing Ora asset convergence guard: ${migrationGuard}`,
  );
}
for (const referenceGuard of [
  "UPDATE public.ora_file_contexts context_row",
  "SET asset_id = NULL",
  "UPDATE public.brand_kits kit",
  "SET logo_asset_id = NULL",
  "row_json ->> TG_ARGV[0]",
  "ora.id = candidate_ora_asset_id",
  "NOT procedure_row.prosecdef",
  "search_path=pg_catalog,public",
  "trigger_row.tgnargs = expected.argument_count",
  "encode(trigger_row.tgargs, 'escape') = expected.argument_bytes",
  "ora_asset_reference_guards_missing",
  "await pool.end()",
]) {
  assert.ok(
    oraAssetReferenceGuardMigrationSource.includes(referenceGuard),
    `missing standalone Ora reference convergence guard: ${referenceGuard}`,
  );
}
for (const [tableName, repairStatement] of [
  ["ora_file_contexts", "UPDATE public.ora_file_contexts context_row"],
  ["brand_kits", "UPDATE public.brand_kits kit"],
] as const) {
  const dropTrigger = oraAssetReferenceGuardMigrationSource.indexOf(
    `DROP TRIGGER IF EXISTS ora_asset_reference_guard_${tableName}`,
  );
  const repair = oraAssetReferenceGuardMigrationSource.indexOf(repairStatement);
  const createTrigger = oraAssetReferenceGuardMigrationSource.indexOf(
    `CREATE TRIGGER ora_asset_reference_guard_${tableName}`,
  );
  assert.ok(dropTrigger >= 0, `missing early trigger drop for ${tableName}`);
  assert.ok(
    dropTrigger < repair && repair < createTrigger,
    `reference repair must run after trigger drop and before recreation for ${tableName}`,
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
