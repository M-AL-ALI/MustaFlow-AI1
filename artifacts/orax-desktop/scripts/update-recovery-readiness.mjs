import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(__dirname, "..");
const repoRoot = resolve(packageRoot, "../..");
const failures = [];

function fail(message) {
  failures.push(message);
  console.error(`[FAIL] ${message}`);
}

function pass(message) {
  console.log(`[PASS] ${message}`);
}

function read(relPath) {
  return readFileSync(join(repoRoot, relPath), "utf8");
}

function requireFile(relPath) {
  const fullPath = join(repoRoot, relPath);
  if (!existsSync(fullPath)) fail(`file missing: ${relPath}`);
  else pass(`file exists: ${relPath}`);
}

function requireContains(relPath, token) {
  const content = read(relPath);
  if (!content.includes(token)) fail(`${relPath} missing ${token}`);
  else pass(`${relPath} contains ${token}`);
}

function requireNotContains(relPath, token) {
  const content = read(relPath);
  if (content.includes(token)) fail(`${relPath} must not contain ${token}`);
  else pass(`${relPath} does not contain ${token}`);
}

requireFile("artifacts/orax-desktop/src/main/support-diagnostics.ts");
requireFile("docs/orax-desktop-update-recovery.md");

requireContains("artifacts/orax-desktop/package.json", '"update:recovery-readiness"');
requireContains("artifacts/orax-desktop/package.json", '"verify:phase3k"');
requireContains("artifacts/orax-desktop/src/main/support-diagnostics.ts", "buildSupportDiagnostics");
requireContains("artifacts/orax-desktop/src/main/support-diagnostics.ts", "includesSessionToken: false");
requireContains("artifacts/orax-desktop/src/main/support-diagnostics.ts", "includesPasswords: false");
requireContains(
  "artifacts/orax-desktop/src/main/support-diagnostics.ts",
  "includesEnvironmentVariables: false",
);
requireContains(
  "artifacts/orax-desktop/src/main/support-diagnostics.ts",
  "includesLocalProjectPaths: false",
);
requireNotContains("artifacts/orax-desktop/src/main/support-diagnostics.ts", "session.token");
requireNotContains("artifacts/orax-desktop/src/main/support-diagnostics.ts", "process.env");
requireContains("artifacts/orax-desktop/src/main/ipc-handlers.ts", "support:exportDiagnostics");
requireContains("artifacts/orax-desktop/src/preload/index.ts", "support:exportDiagnostics");
requireContains("artifacts/orax-desktop/src/renderer/electron-api.d.ts", "SupportDiagnosticsExport");
requireContains("artifacts/orax-desktop/src/renderer/pages/SettingsScreen.tsx", "Export Support Diagnostics");
requireContains("artifacts/orax-desktop/src/renderer/pages/SettingsScreen.tsx", "does not include session tokens");
requireContains("docs/orax-desktop-update-recovery.md", "Update and Recovery");
requireContains("docs/orax-desktop-update-recovery.md", "Rollback");
requireContains("docs/orax-desktop-update-recovery.md", "Support Diagnostics");
requireContains("docs/orax-desktop-update-recovery.md", "Do not include Ora/public-ai chat");

for (const relPath of [
  "artifacts/orax-desktop/src/main/support-diagnostics.ts",
  "artifacts/orax-desktop/src/main/ipc-handlers.ts",
  "artifacts/orax-desktop/src/preload/index.ts",
  "artifacts/orax-desktop/src/renderer/pages/SettingsScreen.tsx",
  "docs/orax-desktop-update-recovery.md",
]) {
  const content = read(relPath);
  const publicAiRoute = ["/api", "public-ai"].join("/") + "/";
  const forbiddenAssistantToken = ["ora", "Chat"].join("");
  if (content.includes(publicAiRoute) || content.includes(forbiddenAssistantToken)) {
    fail(`${relPath} leaks Ora/public-ai references`);
  } else {
    pass(`${relPath} has no Ora/public-ai references`);
  }
}

if (failures.length > 0) {
  console.error(`\nOrax Desktop update/recovery readiness failed: ${failures.length} issue(s).`);
  process.exit(1);
}

console.log("\nOrax Desktop update/recovery readiness passed.");
