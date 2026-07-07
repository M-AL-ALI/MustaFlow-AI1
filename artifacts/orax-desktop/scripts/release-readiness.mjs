import { execFileSync } from "node:child_process";
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

function requireNotTracked(relPath) {
  const output = execFileSync("git", ["ls-files", relPath], {
    cwd: repoRoot,
    encoding: "utf8",
  }).trim();
  if (output.length > 0) fail(`${relPath} has tracked generated files:\n${output}`);
  else pass(`${relPath} has no tracked generated files`);
}

requireFile("artifacts/orax-desktop/scripts/release-manifest.mjs");
requireFile("docs/orax-desktop-release-channel.md");

requireContains("artifacts/orax-desktop/package.json", '"release:manifest"');
requireContains("artifacts/orax-desktop/package.json", '"release:readiness"');
requireContains("artifacts/orax-desktop/package.json", '"verify:phase3h"');
requireContains("artifacts/orax-desktop/electron-builder.yml", "provider: generic");
requireContains(
  "artifacts/orax-desktop/electron-builder.yml",
  "https://downloads.mustaflow.com/orax/desktop/windows",
);
requireContains("artifacts/orax-desktop/scripts/release-manifest.mjs", "sha256");
requireContains("artifacts/orax-desktop/scripts/release-manifest.mjs", "ORAX_DESKTOP_RELEASE_BASE_URL");
requireContains("artifacts/mustaflow/src/pages/orax-product.tsx", "Signed release channel");
requireContains("artifacts/mustaflow/src/pages/orax-product.tsx", "internal release review");
requireContains("docs/orax-desktop-release-channel.md", "Code signing gate");
requireContains("docs/orax-desktop-release-channel.md", "Release artifact manifest");
requireContains("docs/orax-desktop-release-channel.md", "Rollback");

requireNotTracked("artifacts/orax-desktop/release");

for (const relPath of [
  "artifacts/orax-desktop/electron-builder.yml",
  "artifacts/orax-desktop/scripts/release-manifest.mjs",
  "artifacts/orax-desktop/scripts/release-readiness.mjs",
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
  console.error(`\nOrax Desktop release readiness failed: ${failures.length} issue(s).`);
  process.exit(1);
}

console.log("\nOrax Desktop release readiness passed.");
