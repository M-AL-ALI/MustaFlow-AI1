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

requireFile("artifacts/mustaflow/src/pages/orax.tsx");
requireFile("artifacts/ora-mobile/app/(home)/orax.tsx");

for (const relPath of [
  "artifacts/mustaflow/src/pages/orax.tsx",
  "artifacts/ora-mobile/app/(home)/orax.tsx",
]) {
  requireContains(relPath, "Desktop connection status");
  requireContains(relPath, "Desktop required for local execution");
  requireContains(relPath, "Install Orax Desktop");
  requireContains(relPath, "Keep Orax Desktop open");
}

requireContains("artifacts/mustaflow/src/pages/orax.tsx", "/orax/devices");
requireContains("artifacts/mustaflow/src/pages/orax.tsx", "Open device manager");
requireContains("artifacts/ora-mobile/app/(home)/orax.tsx", "Desktop online");
requireContains("artifacts/ora-mobile/app/(home)/orax.tsx", "Desktop offline");
requireContains(
  "artifacts/ora-mobile/app/(home)/orax.tsx",
  "before asking Orax to work on local files",
);

for (const relPath of [
  "artifacts/mustaflow/src/pages/orax.tsx",
  "artifacts/ora-mobile/app/(home)/orax.tsx",
  "artifacts/orax-desktop/scripts/desktop-onboarding-readiness.mjs",
]) {
  const forbiddenPublicAiRoute = ["/api", "public-ai"].join("/") + "/";
  const forbiddenAssistantToken = ["ora", "Chat"].join("");
  const forbiddenAssistantHook = ["use", "Ora", "Chat"].join("");
  requireNotContains(relPath, forbiddenPublicAiRoute);
  requireNotContains(relPath, forbiddenAssistantToken);
  requireNotContains(relPath, forbiddenAssistantHook);
}

if (failures.length > 0) {
  console.error(`\nOrax Desktop onboarding readiness failed: ${failures.length} issue(s).`);
  process.exit(1);
}

console.log("\nOrax Desktop onboarding readiness passed.");
