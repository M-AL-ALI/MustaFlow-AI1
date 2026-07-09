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

function requireOrder(relPath, firstToken, secondToken) {
  const content = read(relPath);
  const firstIndex = content.indexOf(firstToken);
  const secondIndex = content.indexOf(secondToken);
  if (firstIndex === -1 || secondIndex === -1) {
    fail(`${relPath} missing ordered tokens: ${firstToken} before ${secondToken}`);
  } else if (firstIndex >= secondIndex) {
    fail(`${relPath} has wrong order: ${firstToken} must appear before ${secondToken}`);
  } else {
    pass(`${relPath} orders ${firstToken} before ${secondToken}`);
  }
}

requireFile("artifacts/orax-desktop/src/main/support-diagnostics.ts");
requireFile("docs/orax-desktop-update-recovery.md");

requireContains("artifacts/orax-desktop/package.json", '"update:recovery-readiness"');
requireContains("artifacts/orax-desktop/package.json", '"verify:phase3k"');
requireContains("artifacts/orax-desktop/package.json", '"verify:phase3p"');
requireContains("artifacts/orax-desktop/package.json", '"verify:phase3q"');
requireContains("artifacts/orax-desktop/package.json", '"verify:phase3r"');
requireContains("artifacts/orax-desktop/package.json", '"verify:phase3s"');
requireContains("artifacts/orax-desktop/package.json", '"verify:phase3t"');
requireContains("artifacts/orax-desktop/package.json", '"verify:phase3u"');
requireContains("artifacts/orax-desktop/package.json", '"verify:phase3v"');
requireContains("artifacts/orax-desktop/src/main/support-diagnostics.ts", "buildSupportDiagnostics");
requireContains(
  "artifacts/orax-desktop/src/main/support-diagnostics.ts",
  "findSupportDiagnosticsViolations",
);
requireContains(
  "artifacts/orax-desktop/src/main/support-diagnostics.ts",
  "serializeValidatedSupportDiagnostics",
);
requireContains("artifacts/orax-desktop/src/main/support-diagnostics.ts", "Bearer");
requireContains("artifacts/orax-desktop/src/main/support-diagnostics.ts", "PRIVATE KEY");
requireContains("artifacts/orax-desktop/src/main/support-diagnostics.ts", "Windows local path");
requireContains("artifacts/orax-desktop/src/main/support-diagnostics.ts", "includesSessionToken: false");
requireContains("artifacts/orax-desktop/src/main/support-diagnostics.ts", "sanitizeHealthTimeline");
requireContains("artifacts/orax-desktop/src/main/support-diagnostics.ts", "MAX_HEALTH_TIMELINE_ENTRIES");
requireContains(
  "artifacts/orax-desktop/src/main/support-diagnostics.ts",
  "healthTimeline: sanitizeHealthTimeline",
);
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
requireContains("artifacts/orax-desktop/src/main/ipc-handlers.ts", "options?.healthTimeline");
requireContains(
  "artifacts/orax-desktop/src/main/ipc-handlers.ts",
  "serializeValidatedSupportDiagnostics(diagnostics)",
);
requireOrder(
  "artifacts/orax-desktop/src/main/ipc-handlers.ts",
  "serializeValidatedSupportDiagnostics(diagnostics)",
  "writeFile(result.filePath",
);
requireContains("artifacts/orax-desktop/src/preload/index.ts", "support:exportDiagnostics");
requireContains("artifacts/orax-desktop/src/renderer/electron-api.d.ts", "SupportDiagnosticsExport");
requireContains("artifacts/orax-desktop/src/renderer/pages/SettingsScreen.tsx", "Export Support Diagnostics");
requireContains("artifacts/orax-desktop/src/renderer/pages/SettingsScreen.tsx", "does not include session tokens");
requireContains("docs/orax-desktop-update-recovery.md", "Update and Recovery");
requireContains("docs/orax-desktop-update-recovery.md", "Rollback");
requireContains("docs/orax-desktop-update-recovery.md", "Support Diagnostics");
requireContains("docs/orax-desktop-update-recovery.md", "diagnostics payload may include");
requireContains("docs/orax-desktop-update-recovery.md", "verify:phase3p");
requireContains("docs/orax-desktop-update-recovery.md", "verify:phase3q");
requireContains("docs/orax-desktop-update-recovery.md", "verify:phase3r");
requireContains("docs/orax-desktop-update-recovery.md", "verify:phase3s");
requireContains(
  "docs/orax-desktop-update-recovery.md",
  "Diagnostics exported. Health timeline included.",
);
requireContains("docs/orax-desktop-update-recovery.md", "Settings export may have an empty");
requireContains("docs/orax-desktop-update-recovery.md", "Health Smoke Checklist");
requireContains("docs/orax-desktop-update-recovery.md", "Confirm diagnostics success/cancel messages");
requireContains("docs/orax-desktop-update-recovery.md", "Health Checklist Action Shortcuts");
requireContains("docs/orax-desktop-update-recovery.md", "No new IPC APIs");
requireContains("docs/orax-desktop-update-recovery.md", "Health Checklist Completion Summary");
requireContains("docs/orax-desktop-update-recovery.md", "Windows smoke checklist complete");
requireContains("docs/orax-desktop-update-recovery.md", "verify:phase3t");
requireContains("docs/orax-desktop-update-recovery.md", "Health Checklist Manual Confirmations");
requireContains("docs/orax-desktop-update-recovery.md", "Health Next Best Action");
requireContains("docs/orax-desktop-update-recovery.md", "Mark result copy checked");
requireContains("docs/orax-desktop-update-recovery.md", "verify:phase3u");
requireContains("docs/orax-desktop-update-recovery.md", "verify:phase3v");
requireContains("docs/orax-desktop-update-recovery.md", "validated before it is written");
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
