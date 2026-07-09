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

function requireNotContains(relPath, token) {
  const content = read(relPath);
  if (content.includes(token)) fail(`${relPath} must not contain ${token}`);
  else pass(`${relPath} does not contain ${token}`);
}

function requireNotTracked(relPath) {
  const output = execFileSync("git", ["ls-files", relPath], {
    cwd: repoRoot,
    encoding: "utf8",
  }).trim();
  if (output.length > 0) fail(`${relPath} has tracked generated files:\n${output}`);
  else pass(`${relPath} has no tracked generated files`);
}

requireFile("docs/orax-desktop-public-go-live.md");
requireFile("docs/orax-desktop-signing-setup.md");
requireFile("docs/orax-desktop-release-channel.md");
requireFile(".github/workflows/orax-desktop-release.yml");
requireFile("artifacts/mustaflow/src/pages/orax-product.tsx");

requireContains("artifacts/orax-desktop/package.json", '"release:go-live-readiness"');
requireContains("artifacts/orax-desktop/package.json", '"verify:phase3w"');
requireContains("artifacts/orax-desktop/package.json", "release:public-readiness");
requireContains("artifacts/orax-desktop/package.json", "signing:readiness");

requireContains("docs/orax-desktop-public-go-live.md", "Orax Desktop Public Go-Live Checklist");
requireContains("docs/orax-desktop-public-go-live.md", "Public go-live gate");
requireContains("docs/orax-desktop-public-go-live.md", "Never publish unsigned installer");
requireContains("docs/orax-desktop-public-go-live.md", "Signed internal smoke");
requireContains("docs/orax-desktop-public-go-live.md", "Certificate configured");
requireContains("docs/orax-desktop-public-go-live.md", "Manifest uploaded");
requireContains("docs/orax-desktop-public-go-live.md", "Website env switch");
requireContains("docs/orax-desktop-public-go-live.md", "Rollback plan");
requireContains("docs/orax-desktop-public-go-live.md", "Support diagnostics export");
requireContains("docs/orax-desktop-public-go-live.md", "Health smoke checklist");
requireContains("docs/orax-desktop-public-go-live.md", "verify:phase3w");

requireContains("docs/orax-desktop-signing-setup.md", "Orax Desktop Public Go-Live Checklist");
requireContains("docs/orax-desktop-release-channel.md", "Public go-live checklist");
requireContains("docs/orax-desktop-release-channel.md", "verify:phase3w");

requireContains("artifacts/mustaflow/src/pages/orax-product.tsx", "Go-live checklist");
requireContains(
  "artifacts/mustaflow/src/pages/orax-product.tsx",
  "Public download waits for signed smoke and go-live review",
);
requireContains(".github/workflows/orax-desktop-release.yml", "ORAX_WINDOWS_CSC_LINK");
requireContains(".github/workflows/orax-desktop-release.yml", "ORAX_DESKTOP_RELEASE_S3_URI");

requireNotContains("artifacts/mustaflow/src/pages/orax-product.tsx", 'href="/downloads/');
requireNotContains("artifacts/mustaflow/src/pages/orax-product.tsx", 'href="/support/tickets"');
requireNotTracked("artifacts/orax-desktop/release");

for (const relPath of [
  "docs/orax-desktop-public-go-live.md",
  "docs/orax-desktop-signing-setup.md",
  "docs/orax-desktop-release-channel.md",
  "artifacts/orax-desktop/scripts/release-go-live-readiness.mjs",
  "artifacts/mustaflow/src/pages/orax-product.tsx",
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
  console.error(`\nOrax Desktop go-live readiness failed: ${failures.length} issue(s).`);
  process.exit(1);
}

console.log("\nOrax Desktop go-live readiness passed.");
