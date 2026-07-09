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

requireFile("docs/orax-desktop-signing-setup.md");
requireFile(".github/workflows/orax-desktop-release.yml");

requireContains("artifacts/orax-desktop/package.json", '"signing:readiness"');
requireContains("artifacts/orax-desktop/package.json", '"verify:phase3v"');
requireContains("docs/orax-desktop-signing-setup.md", "Orax Desktop Signing Setup");
requireContains("docs/orax-desktop-signing-setup.md", "Internal unsigned installer");
requireContains("docs/orax-desktop-signing-setup.md", "users do not sign Orax");
requireContains("docs/orax-desktop-signing-setup.md", "ORAX_WINDOWS_CSC_LINK");
requireContains("docs/orax-desktop-signing-setup.md", "ORAX_WINDOWS_CSC_KEY_PASSWORD");
requireContains("docs/orax-desktop-signing-setup.md", "ORAX_RELEASE_AWS_ACCESS_KEY_ID");
requireContains("docs/orax-desktop-signing-setup.md", "ORAX_DESKTOP_RELEASE_S3_URI");
requireContains("docs/orax-desktop-signing-setup.md", "Azure Artifact Signing");
requireContains("docs/orax-desktop-signing-setup.md", "Do not enable public download");
requireContains(".github/workflows/orax-desktop-release.yml", "ORAX_WINDOWS_CSC_LINK");
requireContains(".github/workflows/orax-desktop-release.yml", "ORAX_WINDOWS_CSC_KEY_PASSWORD");
requireContains(".github/workflows/orax-desktop-release.yml", "ORAX_DESKTOP_RELEASE_S3_URI");

for (const relPath of [
  "docs/orax-desktop-signing-setup.md",
  "artifacts/orax-desktop/scripts/signing-readiness.mjs",
  ".github/workflows/orax-desktop-release.yml",
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
  console.error(`\nOrax Desktop signing readiness failed: ${failures.length} issue(s).`);
  process.exit(1);
}

console.log("\nOrax Desktop signing readiness passed.");
