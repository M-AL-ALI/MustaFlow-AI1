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

// --- Phase 3M: Health Check Panel ---

requireFile("artifacts/orax-desktop/src/renderer/pages/HealthScreen.tsx");

requireContains("artifacts/orax-desktop/package.json", '"health:readiness"');
requireContains("artifacts/orax-desktop/package.json", '"verify:phase3m"');
requireContains("artifacts/orax-desktop/package.json", '"verify:phase3n"');
requireContains("artifacts/orax-desktop/package.json", '"verify:phase3o"');
requireContains("artifacts/orax-desktop/package.json", '"verify:phase3p"');
requireContains("artifacts/orax-desktop/package.json", '"verify:phase3q"');
requireContains("artifacts/orax-desktop/src/renderer/App.tsx", "HealthScreen");
requireContains("artifacts/orax-desktop/src/renderer/context/AppContext.tsx", '"health"');
requireContains("artifacts/orax-desktop/src/renderer/components/Sidebar.tsx", 'label: "Health"');
requireContains("artifacts/orax-desktop/src/renderer/pages/HealthScreen.tsx", "Health Check");
requireContains("artifacts/orax-desktop/src/renderer/pages/HealthScreen.tsx", "Sign-in status");
requireContains("artifacts/orax-desktop/src/renderer/pages/HealthScreen.tsx", "Host registration");
requireContains("artifacts/orax-desktop/src/renderer/pages/HealthScreen.tsx", "Heartbeat status");
requireContains("artifacts/orax-desktop/src/renderer/pages/HealthScreen.tsx", "Relay polling");
requireContains("artifacts/orax-desktop/src/renderer/pages/HealthScreen.tsx", "Pairing readiness");
requireContains("artifacts/orax-desktop/src/renderer/pages/HealthScreen.tsx", "Release channel");
requireContains("artifacts/orax-desktop/src/renderer/pages/HealthScreen.tsx", "Diagnostics export");
requireContains("artifacts/orax-desktop/src/renderer/pages/HealthScreen.tsx", "Export Support Diagnostics");
requireContains("artifacts/orax-desktop/src/renderer/pages/HealthScreen.tsx", "support.exportDiagnostics");
requireContains("docs/orax-desktop-update-recovery.md", "Health Check Panel");
requireContains("docs/orax-desktop-update-recovery.md", "Sign-in status");
requireContains("docs/orax-desktop-update-recovery.md", "Relay polling");

// --- Phase 3N: Health Recovery Actions ---

requireContains("artifacts/orax-desktop/package.json", '"verify:phase3n"');

requireContains("artifacts/orax-desktop/src/renderer/pages/HealthScreen.tsx", "Sign in again");
requireContains("artifacts/orax-desktop/src/renderer/pages/HealthScreen.tsx", "Reconnect host");
requireContains("artifacts/orax-desktop/src/renderer/pages/HealthScreen.tsx", "Restart relay");
requireContains("artifacts/orax-desktop/src/renderer/pages/HealthScreen.tsx", "Open pairing");
requireContains("artifacts/orax-desktop/src/renderer/pages/HealthScreen.tsx", "Check release status");
requireContains("artifacts/orax-desktop/src/renderer/pages/HealthScreen.tsx", "redactForDisplay");
requireContains("artifacts/orax-desktop/src/renderer/pages/HealthScreen.tsx", "lastAttempted");
requireContains("artifacts/orax-desktop/src/renderer/pages/HealthScreen.tsx", "registerHost");
requireContains("artifacts/orax-desktop/src/renderer/pages/HealthScreen.tsx", "relay.restart");
requireContains("artifacts/orax-desktop/src/renderer/pages/HealthScreen.tsx", 'setPage("pairing")');
requireContains("artifacts/orax-desktop/src/renderer/pages/HealthScreen.tsx", "Action timeline");
requireContains("artifacts/orax-desktop/src/renderer/pages/HealthScreen.tsx", "actionHistory");
requireContains("artifacts/orax-desktop/src/renderer/pages/HealthScreen.tsx", "recordActionEvent");
requireContains("artifacts/orax-desktop/src/renderer/pages/HealthScreen.tsx", "updateActionEvent");

requireContains("artifacts/orax-desktop/src/main/ipc-handlers.ts", "relay:restart");
requireContains("artifacts/orax-desktop/src/preload/index.ts", "relay:restart");
requireContains("artifacts/orax-desktop/src/renderer/lib/ipc.ts", "restart");
requireContains("artifacts/orax-desktop/src/renderer/electron-api.d.ts", "restart");

requireContains("docs/orax-desktop-update-recovery.md", "Health Recovery Actions");
requireContains("docs/orax-desktop-update-recovery.md", "Health Action Timeline");
requireContains("docs/orax-desktop-update-recovery.md", "verify:phase3n");
requireContains("docs/orax-desktop-update-recovery.md", "verify:phase3o");

// --- Phase 3P: Health Timeline in Support Diagnostics ---

requireContains("artifacts/orax-desktop/src/renderer/pages/HealthScreen.tsx", "healthTimeline");
requireContains(
  "artifacts/orax-desktop/src/renderer/pages/HealthScreen.tsx",
  "SupportDiagnosticsHealthTimelineEntry",
);
requireContains(
  "artifacts/orax-desktop/src/main/support-diagnostics.ts",
  "sanitizeHealthTimeline",
);
requireContains(
  "artifacts/orax-desktop/src/main/support-diagnostics.ts",
  "MAX_HEALTH_TIMELINE_ENTRIES",
);
requireContains(
  "artifacts/orax-desktop/src/main/support-diagnostics.ts",
  "healthTimeline: sanitizeHealthTimeline",
);
requireContains("artifacts/orax-desktop/src/main/ipc-handlers.ts", "options?.healthTimeline");
requireContains("artifacts/orax-desktop/src/preload/index.ts", "SupportDiagnosticsExportOptions");
requireContains("artifacts/orax-desktop/src/renderer/lib/ipc.ts", "SupportDiagnosticsExportOptions");
requireContains("docs/orax-desktop-update-recovery.md", "diagnostics payload may include");
requireContains("docs/orax-desktop-update-recovery.md", "verify:phase3p");

// --- Phase 3Q: Health Diagnostics Export Result UX ---

requireContains(
  "artifacts/orax-desktop/src/renderer/pages/HealthScreen.tsx",
  "Diagnostics exported. Health timeline included.",
);
requireContains(
  "artifacts/orax-desktop/src/renderer/pages/HealthScreen.tsx",
  "Diagnostics export cancelled.",
);
requireContains(
  "artifacts/orax-desktop/src/renderer/pages/HealthScreen.tsx",
  "Included in diagnostics export from Health.",
);
requireContains(
  "artifacts/orax-desktop/src/renderer/pages/HealthScreen.tsx",
  "No timeline entries to include yet.",
);
requireNotContains("artifacts/orax-desktop/src/renderer/pages/HealthScreen.tsx", "result.filePath");
requireNotContains(
  "artifacts/orax-desktop/src/renderer/pages/HealthScreen.tsx",
  "result.diagnostics",
);
requireContains("docs/orax-desktop-update-recovery.md", "verify:phase3q");
requireContains(
  "docs/orax-desktop-update-recovery.md",
  "Diagnostics exported. Health timeline included.",
);
requireContains("docs/orax-desktop-update-recovery.md", "Settings export may have an empty");

// --- Ora isolation check (all health files) ---

for (const relPath of [
  "artifacts/orax-desktop/src/renderer/pages/HealthScreen.tsx",
  "artifacts/orax-desktop/src/renderer/App.tsx",
  "artifacts/orax-desktop/src/renderer/components/Sidebar.tsx",
  "artifacts/orax-desktop/src/main/support-diagnostics.ts",
  "artifacts/orax-desktop/src/main/ipc-handlers.ts",
  "artifacts/orax-desktop/src/preload/index.ts",
  "artifacts/orax-desktop/src/renderer/lib/ipc.ts",
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
  console.error(`\nOrax Desktop health readiness failed: ${failures.length} issue(s).`);
  process.exit(1);
}

console.log("\nOrax Desktop health readiness passed.");
