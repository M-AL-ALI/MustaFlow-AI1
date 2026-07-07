import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(__dirname, "..");
const releaseDir = join(packageRoot, "release");
const packageJson = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
const version = packageJson.version;
const files = [
  `Orax-Desktop-${version}-x64-Setup.exe`,
  `Orax-Desktop-${version}-x64-Setup.exe.blockmap`,
  "latest.yml",
  "orax-desktop-windows-latest.json",
];

const publishEnabled = process.env.ORAX_DESKTOP_RELEASE_PUBLISH === "true";
const s3Uri = process.env.ORAX_DESKTOP_RELEASE_S3_URI;
const endpoint = process.env.ORAX_DESKTOP_RELEASE_S3_ENDPOINT;

function requireFile(name) {
  const filePath = join(releaseDir, name);
  if (!existsSync(filePath)) {
    console.error(`Missing release artifact: ${filePath}`);
    process.exit(1);
  }
  return filePath;
}

const filePaths = files.map(requireFile);

if (!publishEnabled) {
  console.log("Release upload dry run. Set ORAX_DESKTOP_RELEASE_PUBLISH=true to upload.");
  for (const filePath of filePaths) {
    console.log(`ready: ${filePath}`);
  }
  process.exit(0);
}

if (!s3Uri || !s3Uri.startsWith("s3://")) {
  console.error("ORAX_DESKTOP_RELEASE_S3_URI must be set to an s3:// bucket/prefix URI.");
  process.exit(1);
}

for (const filePath of filePaths) {
  const args = ["s3", "cp", filePath, `${s3Uri.replace(/\/$/, "")}/`];
  if (endpoint) {
    args.push("--endpoint-url", endpoint);
  }
  execFileSync("aws", args, { stdio: "inherit" });
}

console.log(`Uploaded ${filePaths.length} Orax Desktop release artifact(s) to ${s3Uri}.`);
