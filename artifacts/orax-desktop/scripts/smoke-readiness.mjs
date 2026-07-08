import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(packageRoot, "../..");

const checks = [];

function pass(label) {
  checks.push({ label, ok: true });
}

function fail(label, detail) {
  checks.push({ label, ok: false, detail });
}

function read(relPath) {
  return fs.readFileSync(path.join(repoRoot, relPath), "utf8");
}

function exists(relPath) {
  return fs.existsSync(path.join(repoRoot, relPath));
}

function requireFile(relPath) {
  if (exists(relPath)) pass(`file exists: ${relPath}`);
  else fail(`file exists: ${relPath}`, "missing");
}

function requireContains(relPath, needle, label = `${relPath} contains ${needle}`) {
  try {
    const source = read(relPath);
    if (source.includes(needle)) pass(label);
    else fail(label, `missing "${needle}"`);
  } catch (error) {
    fail(label, error instanceof Error ? error.message : "read failed");
  }
}

function requireNotContains(relPath, needle, label = `${relPath} does not contain ${needle}`) {
  try {
    const source = read(relPath);
    if (!source.includes(needle)) pass(label);
    else fail(label, `found forbidden "${needle}"`);
  } catch (error) {
    fail(label, error instanceof Error ? error.message : "read failed");
  }
}

function requireJsonScript(scriptName) {
  try {
    const pkg = JSON.parse(read("artifacts/orax-desktop/package.json"));
    if (pkg.scripts?.[scriptName]) pass(`package script exists: ${scriptName}`);
    else fail(`package script exists: ${scriptName}`, "missing");
  } catch (error) {
    fail(`package script exists: ${scriptName}`, error instanceof Error ? error.message : "read failed");
  }
}

const requiredFiles = [
  "artifacts/orax-desktop/electron.vite.config.ts",
  "artifacts/orax-desktop/src/main/index.ts",
  "artifacts/orax-desktop/src/main/api-client.ts",
  "artifacts/orax-desktop/src/main/host-manager.ts",
  "artifacts/orax-desktop/src/main/pairing-manager.ts",
  "artifacts/orax-desktop/src/main/relay-client.ts",
  "artifacts/orax-desktop/src/main/project-inspector.ts",
  "artifacts/orax-desktop/src/main/project-file-selector.ts",
  "artifacts/orax-desktop/src/main/project-file-reader.ts",
  "artifacts/orax-desktop/src/main/project-patch-drafter.ts",
  "artifacts/orax-desktop/src/main/project-patch-applier.ts",
  "artifacts/orax-desktop/src/main/project-patch-verifier.ts",
  "artifacts/orax-desktop/src/main/project-fix-drafter.ts",
  "artifacts/orax-desktop/src/main/project-git-workflow.ts",
  "artifacts/orax-desktop/src/renderer/pages/SignInScreen.tsx",
  "artifacts/orax-desktop/src/renderer/pages/SetupScreen.tsx",
  "artifacts/orax-desktop/src/renderer/pages/PairingScreen.tsx",
  "artifacts/orax-desktop/src/renderer/pages/HomeScreen.tsx",
  "artifacts/orax-desktop/src/renderer/pages/HealthScreen.tsx",
  "artifacts/orax-desktop/src/renderer/pages/ProjectsScreen.tsx",
  "artifacts/orax-desktop/src/renderer/pages/SettingsScreen.tsx",
  "docs/orax-desktop-e2e-smoke-test.md",
];

for (const relPath of requiredFiles) requireFile(relPath);

requireJsonScript("typecheck");
requireJsonScript("build");
requireJsonScript("smoke:readiness");
requireJsonScript("verify:phase3d");

requireContains("artifacts/orax-desktop/src/renderer/pages/SignInScreen.tsx", "No password is entered here");
requireNotContains("artifacts/orax-desktop/src/renderer/pages/SignInScreen.tsx", 'type="password"');
requireNotContains("artifacts/orax-desktop/src/renderer/pages/SignInScreen.tsx", "future update");
requireContains("artifacts/orax-desktop/src/main/auth.ts", "/api/orax/desktop-auth/start");
requireContains("artifacts/orax-desktop/src/main/auth.ts", "/api/orax/desktop-auth/status/");
requireContains("artifacts/orax-desktop/src/main/auth.ts", "storeEncrypted(SESSION_STORE_KEY");
requireContains("artifacts/orax-desktop/src/renderer/pages/SetupScreen.tsx", "Welcome to Orax");
requireContains("artifacts/orax-desktop/src/renderer/pages/SetupScreen.tsx", "after your approval");
requireContains("artifacts/orax-desktop/src/renderer/pages/PairingScreen.tsx", "Generate Pairing Code");
requireNotContains("artifacts/orax-desktop/src/renderer/pages/PairingScreen.tsx", "Phase 2D");
requireContains("artifacts/orax-desktop/src/renderer/pages/HomeScreen.tsx", "Relay");
requireContains("artifacts/orax-desktop/src/renderer/pages/HealthScreen.tsx", "Health Check");
requireContains("artifacts/orax-desktop/src/renderer/pages/HealthScreen.tsx", "Relay polling");
requireContains("artifacts/orax-desktop/src/renderer/pages/HealthScreen.tsx", "Action timeline");
requireContains("artifacts/orax-desktop/src/renderer/pages/HealthScreen.tsx", "Sign in again");
requireContains("artifacts/orax-desktop/src/renderer/pages/HealthScreen.tsx", "Reconnect host");
requireContains("artifacts/orax-desktop/src/renderer/pages/HealthScreen.tsx", "Restart relay");
requireContains("artifacts/orax-desktop/src/renderer/pages/HealthScreen.tsx", "redactForDisplay");
requireContains("artifacts/orax-desktop/src/main/ipc-handlers.ts", "relay:restart");
requireContains("artifacts/orax-desktop/src/preload/index.ts", "relay:restart");
requireContains("artifacts/orax-desktop/src/renderer/pages/ProjectsScreen.tsx", "Cloud Projects");
requireContains("artifacts/orax-desktop/src/renderer/pages/ProjectsScreen.tsx", ".orax/project.json");
requireContains("artifacts/orax-desktop/src/renderer/pages/SettingsScreen.tsx", "PERMISSION_MODE_LABELS");

for (const action of [
  "run_project_thread",
  "draft_project_patch",
  "apply_project_patch",
  "verify_project_patch",
  "draft_project_fix",
  "prepare_project_pr",
]) {
  requireContains("artifacts/orax-desktop/src/main/relay-client.ts", action, `relay handles ${action}`);
}

requireContains("artifacts/orax-desktop/src/main/project-patch-applier.ts", ".orax");
requireContains("artifacts/orax-desktop/src/main/project-patch-applier.ts", "checkpoints");
requireContains("artifacts/orax-desktop/src/main/project-git-workflow.ts", "prepareProjectPr");
requireContains("artifacts/orax-desktop/src/main/project-git-workflow.ts", "parseGitHubRemote");
requireContains("artifacts/orax-desktop/src/main/project-git-workflow.ts", "redactToken");

for (const relPath of [
  "artifacts/orax-desktop/src/main/project-file-selector.ts",
  "artifacts/orax-desktop/src/main/project-file-reader.ts",
  "artifacts/orax-desktop/src/main/project-patch-drafter.ts",
  "artifacts/orax-desktop/src/main/project-patch-applier.ts",
  "artifacts/orax-desktop/src/main/project-patch-verifier.ts",
  "artifacts/orax-desktop/src/main/project-fix-drafter.ts",
]) {
  requireNotContains(relPath, "exec(");
  requireNotContains(relPath, "shell: true");
  requireNotContains(relPath, "process.cwd()");
}

for (const forbidden of ["git reset --hard", "git clean -fd", "--force"]) {
  requireNotContains("artifacts/orax-desktop/src/main/project-git-workflow.ts", forbidden);
}

if (exists("attached_assets")) {
  const phasePromptFiles = fs
    .readdirSync(path.join(repoRoot, "attached_assets"))
    .filter((name) => /^Pasted-Start-Phase-3/i.test(name));
  if (phasePromptFiles.length === 0) pass("no Phase 3 pasted task prompts in attached_assets");
  else fail("no Phase 3 pasted task prompts in attached_assets", phasePromptFiles.join(", "));
} else {
  pass("attached_assets absent");
}

const failures = checks.filter((check) => !check.ok);

for (const check of checks) {
  const marker = check.ok ? "PASS" : "FAIL";
  const detail = check.detail ? ` - ${check.detail}` : "";
  console.log(`[${marker}] ${check.label}${detail}`);
}

if (failures.length > 0) {
  console.error(`\nOrax Desktop readiness failed: ${failures.length} issue(s).`);
  process.exit(1);
}

console.log(`\nOrax Desktop readiness passed: ${checks.length} checks.`);
