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

requireFile("artifacts/orax-desktop/src/renderer/pages/HealthScreen.tsx");

requireContains("artifacts/orax-desktop/package.json", '"health:readiness"');
requireContains("artifacts/orax-desktop/package.json", '"verify:phase3m"');
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

for (const relPath of [
  "artifacts/orax-desktop/src/renderer/pages/HealthScreen.tsx",
  "artifacts/orax-desktop/src/renderer/App.tsx",
  "artifacts/orax-desktop/src/renderer/components/Sidebar.tsx",
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
