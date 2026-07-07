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

requireFile("artifacts/orax-desktop/electron-builder.yml");
requireFile("artifacts/orax-desktop/build/icon.svg");

requireContains("artifacts/orax-desktop/package.json", '"package:win"');
requireContains("artifacts/orax-desktop/package.json", '"verify:phase3g"');
requireContains("artifacts/orax-desktop/package.json", "electron-builder");
requireContains("artifacts/orax-desktop/electron-builder.yml", "productName: Orax Desktop");
requireContains("artifacts/orax-desktop/electron-builder.yml", "appId: ai.mustaflow.orax.desktop");
requireContains("artifacts/orax-desktop/electron-builder.yml", "target: nsis");
requireContains("artifacts/orax-desktop/electron-builder.yml", "artifactName: Orax-Desktop-${version}-${arch}-Setup.${ext}");
requireContains(".gitignore", "artifacts/orax-desktop/release/");
requireContains("artifacts/mustaflow/src/pages/orax-product.tsx", "Installer build pending public release");
requireContains("artifacts/mustaflow/src/pages/orax-product.tsx", "Request early access");

requireNotTracked("artifacts/orax-desktop/release");

for (const relPath of [
  "artifacts/orax-desktop/electron-builder.yml",
  "artifacts/orax-desktop/scripts/installer-readiness.mjs",
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
  console.error(`\nOrax Desktop installer readiness failed: ${failures.length} issue(s).`);
  process.exit(1);
}

console.log("\nOrax Desktop installer readiness passed.");
