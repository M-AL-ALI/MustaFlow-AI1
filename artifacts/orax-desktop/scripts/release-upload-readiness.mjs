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

requireFile(".github/workflows/orax-desktop-release.yml");
requireFile("artifacts/orax-desktop/scripts/release-upload.mjs");

requireContains("artifacts/orax-desktop/package.json", '"release:upload"');
requireContains("artifacts/orax-desktop/package.json", '"release:upload-readiness"');
requireContains("artifacts/orax-desktop/package.json", '"verify:phase3i"');
requireContains(".github/workflows/orax-desktop-release.yml", "workflow_dispatch");
requireContains(".github/workflows/orax-desktop-release.yml", "windows-latest");
requireContains(".github/workflows/orax-desktop-release.yml", "ORAX_WINDOWS_CSC_LINK");
requireContains(".github/workflows/orax-desktop-release.yml", "ORAX_WINDOWS_CSC_KEY_PASSWORD");
requireContains(".github/workflows/orax-desktop-release.yml", "ORAX_DESKTOP_RELEASE_S3_URI");
requireContains(
  ".github/workflows/orax-desktop-release.yml",
  "pnpm --filter @workspace/orax-desktop run package:win",
);
requireContains(
  ".github/workflows/orax-desktop-release.yml",
  "pnpm --filter @workspace/orax-desktop run release:manifest",
);
requireContains(
  ".github/workflows/orax-desktop-release.yml",
  "pnpm --filter @workspace/orax-desktop run release:upload",
);
requireContains(
  "artifacts/orax-desktop/scripts/release-upload.mjs",
  "ORAX_DESKTOP_RELEASE_PUBLISH",
);
requireContains("artifacts/orax-desktop/scripts/release-upload.mjs", "ORAX_DESKTOP_RELEASE_S3_URI");
requireContains("artifacts/orax-desktop/scripts/release-upload.mjs", "aws");
requireContains("docs/orax-desktop-release-channel.md", "GitHub Actions release workflow");
requireContains("docs/orax-desktop-release-channel.md", "Required GitHub secrets");
requireContains("artifacts/mustaflow/src/pages/orax-product.tsx", "Release automation");

requireNotTracked("artifacts/orax-desktop/release");

for (const relPath of [
  ".github/workflows/orax-desktop-release.yml",
  "artifacts/orax-desktop/scripts/release-upload.mjs",
  "artifacts/orax-desktop/scripts/release-upload-readiness.mjs",
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
  console.error(`\nOrax Desktop release upload readiness failed: ${failures.length} issue(s).`);
  process.exit(1);
}

console.log("\nOrax Desktop release upload readiness passed.");
