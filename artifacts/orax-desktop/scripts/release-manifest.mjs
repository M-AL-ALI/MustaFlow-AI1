import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(__dirname, "..");
const packageJson = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
const version = packageJson.version;
const releaseDir = join(packageRoot, "release");
const installerName = `Orax-Desktop-${version}-x64-Setup.exe`;
const installerPath = join(releaseDir, installerName);

if (!existsSync(installerPath)) {
  console.error(
    `Missing installer: ${installerPath}\nRun pnpm --filter @workspace/orax-desktop run package:win first.`,
  );
  process.exit(1);
}

const bytes = readFileSync(installerPath);
const sha256 = createHash("sha256").update(bytes).digest("hex");
const baseUrl =
  process.env.ORAX_DESKTOP_RELEASE_BASE_URL ||
  "https://downloads.mustaflow.com/orax/desktop/windows";
const channel = process.env.ORAX_DESKTOP_RELEASE_CHANNEL || "internal";
const manifest = {
  product: "Orax Desktop",
  appId: "ai.mustaflow.orax.desktop",
  platform: "win32",
  arch: "x64",
  channel,
  version,
  installerFile: installerName,
  sizeBytes: bytes.length,
  sha256,
  downloadUrl: `${baseUrl.replace(/\/$/, "")}/${installerName}`,
  generatedAt: new Date().toISOString(),
};

mkdirSync(releaseDir, { recursive: true });
const manifestPath = join(releaseDir, "orax-desktop-windows-latest.json");
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Wrote ${manifestPath}`);
console.log(`sha256=${sha256}`);
