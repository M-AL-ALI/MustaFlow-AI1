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

requireFile("artifacts/mustaflow/src/lib/orax-desktop-release.ts");
requireFile("artifacts/mustaflow/src/pages/orax-product.tsx");

requireContains("artifacts/orax-desktop/package.json", '"release:public-readiness"');
requireContains("artifacts/orax-desktop/package.json", '"verify:phase3j"');
requireContains(
  "artifacts/mustaflow/src/lib/orax-desktop-release.ts",
  "VITE_ORAX_DESKTOP_PUBLIC_DOWNLOAD_ENABLED",
);
requireContains(
  "artifacts/mustaflow/src/lib/orax-desktop-release.ts",
  "VITE_ORAX_DESKTOP_RELEASE_MANIFEST_URL",
);
requireContains("artifacts/mustaflow/src/lib/orax-desktop-release.ts", "downloadUrl");
requireContains("artifacts/mustaflow/src/lib/orax-desktop-release.ts", "sha256");
requireContains(
  "artifacts/mustaflow/src/lib/orax-desktop-release.ts",
  "isValidOraxDesktopManifest",
);
requireContains("artifacts/mustaflow/src/pages/orax-product.tsx", "Public download disabled");
requireContains("artifacts/mustaflow/src/pages/orax-product.tsx", "Release manifest unavailable");
requireContains("artifacts/mustaflow/src/pages/orax-product.tsx", "Download for Windows");
requireContains("artifacts/mustaflow/src/pages/orax-product.tsx", "Check installer status");
requireContains("artifacts/mustaflow/src/pages/orax-product.tsx", "Installer not available yet");
requireContains("artifacts/mustaflow/src/pages/orax-product.tsx", "PowerShell");
requireContains("artifacts/mustaflow/src/pages/orax-product.tsx", "Node.js");
requireContains("artifacts/mustaflow/src/pages/orax-product.tsx", "Request early access");
requireContains("docs/orax-desktop-release-channel.md", "Public download switch");
requireContains(
  "docs/orax-desktop-release-channel.md",
  "VITE_ORAX_DESKTOP_PUBLIC_DOWNLOAD_ENABLED=true",
);
requireContains("docs/orax-desktop-release-channel.md", "VITE_ORAX_DESKTOP_RELEASE_MANIFEST_URL");
requireNotContains("artifacts/mustaflow/src/pages/orax-product.tsx", 'href="/downloads/');
requireNotContains("artifacts/mustaflow/src/pages/orax-product.tsx", 'href="/support/tickets"');

for (const relPath of [
  "artifacts/mustaflow/src/lib/orax-desktop-release.ts",
  "artifacts/mustaflow/src/pages/orax-product.tsx",
  "artifacts/orax-desktop/scripts/release-public-readiness.mjs",
  "docs/orax-desktop-release-channel.md",
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
  console.error(`\nOrax Desktop public download readiness failed: ${failures.length} issue(s).`);
  process.exit(1);
}

console.log("\nOrax Desktop public download readiness passed.");
