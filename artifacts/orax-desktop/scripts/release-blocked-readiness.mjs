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

requireFile("artifacts/mustaflow/src/pages/orax-product.tsx");
requireFile("artifacts/mustaflow/src/pages/orax-devices.tsx");
requireFile("artifacts/ora-mobile/app/(home)/orax.tsx");

requireContains("artifacts/mustaflow/src/pages/orax-product.tsx", "Release not public yet");
requireContains("artifacts/mustaflow/src/pages/orax-product.tsx", "Nothing is wrong with your account");
requireContains("artifacts/mustaflow/src/pages/orax-product.tsx", "The installer appears here only after signing");
requireContains("artifacts/mustaflow/src/pages/orax-product.tsx", "Windows smoke testing");
requireContains("artifacts/mustaflow/src/pages/orax-product.tsx", "manifest validation");

requireContains("artifacts/mustaflow/src/pages/orax-devices.tsx", "No desktop connected");
requireContains("artifacts/mustaflow/src/pages/orax-devices.tsx", "This page will show your paired desktops");
requireContains("artifacts/mustaflow/src/pages/orax-devices.tsx", "Check installer status");
requireContains("artifacts/mustaflow/src/pages/orax-devices.tsx", "signed release");
requireContains("artifacts/mustaflow/src/pages/orax-devices.tsx", "confirm the desktop is online");

requireContains("artifacts/ora-mobile/app/(home)/orax.tsx", "Orax Mobile is a remote controller");
requireContains("artifacts/ora-mobile/app/(home)/orax.tsx", "not the execution machine");
requireContains("artifacts/ora-mobile/app/(home)/orax.tsx", "monitors and approves desktop work");
requireContains("artifacts/ora-mobile/app/(home)/orax.tsx", "resume local execution from this phone");

requireNotContains("artifacts/mustaflow/src/pages/orax-product.tsx", 'href="/downloads/');
requireNotContains("artifacts/mustaflow/src/pages/orax-product.tsx", 'href="/support/tickets"');

for (const relPath of [
  "artifacts/mustaflow/src/pages/orax-product.tsx",
  "artifacts/mustaflow/src/pages/orax-devices.tsx",
  "artifacts/ora-mobile/app/(home)/orax.tsx",
  "artifacts/orax-desktop/scripts/release-blocked-readiness.mjs",
]) {
  const forbiddenPublicAiRoute = ["/api", "public-ai"].join("/") + "/";
  const forbiddenAssistantToken = ["ora", "Chat"].join("");
  const forbiddenAssistantHook = ["use", "Ora", "Chat"].join("");
  requireNotContains(relPath, forbiddenPublicAiRoute);
  requireNotContains(relPath, forbiddenAssistantToken);
  requireNotContains(relPath, forbiddenAssistantHook);
}

if (failures.length > 0) {
  console.error(`\nOrax Desktop release-blocked readiness failed: ${failures.length} issue(s).`);
  process.exit(1);
}

console.log("\nOrax Desktop release-blocked readiness passed.");
