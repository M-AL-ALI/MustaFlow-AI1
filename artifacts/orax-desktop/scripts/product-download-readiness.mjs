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
requireFile("docs/orax-desktop-public-go-live.md");

requireContains("artifacts/orax-desktop/package.json", '"product:download-readiness"');
requireContains("artifacts/orax-desktop/package.json", '"verify:phase3x"');
requireContains("artifacts/mustaflow/src/pages/orax-product.tsx", "Why download is gated");
requireContains("artifacts/mustaflow/src/pages/orax-product.tsx", "No support-ticket detour");
requireContains("artifacts/mustaflow/src/pages/orax-product.tsx", "Users do not configure GitHub");
requireContains("artifacts/mustaflow/src/pages/orax-product.tsx", "What happens after install");
requireContains(
  "artifacts/mustaflow/src/pages/orax-product.tsx",
  "PowerShell, Git, Node.js, npm, and pnpm",
);
requireContains("artifacts/mustaflow/src/pages/orax-product.tsx", "Signed installer required");
requireContains("artifacts/mustaflow/src/pages/orax-product.tsx", "Manifest controls the link");
requireContains("artifacts/mustaflow/src/pages/orax-product.tsx", "Windows smoke test required");
requireContains("docs/orax-desktop-public-go-live.md", "Product download experience");
requireContains("docs/orax-desktop-public-go-live.md", "No support-ticket detour");
requireContains("docs/orax-desktop-public-go-live.md", "Users do not configure GitHub");
requireContains("docs/orax-desktop-public-go-live.md", "verify:phase3x");

requireNotContains("artifacts/mustaflow/src/pages/orax-product.tsx", 'href="/downloads/');
requireNotContains("artifacts/mustaflow/src/pages/orax-product.tsx", 'href="/support/tickets"');

for (const relPath of [
  "artifacts/mustaflow/src/pages/orax-product.tsx",
  "artifacts/orax-desktop/scripts/product-download-readiness.mjs",
  "docs/orax-desktop-public-go-live.md",
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
  console.error(`\nOrax Desktop product download readiness failed: ${failures.length} issue(s).`);
  process.exit(1);
}

console.log("\nOrax Desktop product download readiness passed.");
