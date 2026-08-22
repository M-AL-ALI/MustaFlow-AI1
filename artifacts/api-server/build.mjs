import { createRequire } from "node:module";
import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { build as esbuild } from "esbuild";
import esbuildPluginPino from "esbuild-plugin-pino";
import { copyFile, mkdir, readdir, rm, writeFile } from "node:fs/promises";

// Plugins (e.g. 'esbuild-plugin-pino') may use `require` to resolve dependencies
globalThis.require = createRequire(import.meta.url);

const artifactDir = path.dirname(fileURLToPath(import.meta.url));
const repositoryDir = path.resolve(artifactDir, "..", "..");
const eligibilityAssetDirectory = "zero-eligibility-assets";
const execFileAsync = promisify(execFile);
const gitObjectId = /^[0-9a-f]{40}$/;

async function readGitObjectId(revision) {
  const { stdout } = await execFileAsync("git", ["rev-parse", revision], {
    cwd: repositoryDir,
    timeout: 10_000,
    maxBuffer: 64 * 1024,
  });
  const objectId = stdout.trim();
  if (!gitObjectId.test(objectId)) {
    throw new Error(`git rev-parse ${revision} did not return a full object id`);
  }
  return objectId;
}

async function createBuildInfo() {
  const [commit, tree] = await Promise.all([
    readGitObjectId("HEAD"),
    readGitObjectId("HEAD^{tree}"),
  ]);
  return { commit, tree, builtAt: new Date().toISOString() };
}

async function copyEligibilityAssets(distDir) {
  const assetRoot = path.join(distDir, eligibilityAssetDirectory);
  for (const [kind, marker] of [
    ["blueprints", "blueprint.json"],
    ["skills", "SKILL.md"],
  ]) {
    const sourceRoot = path.join(repositoryDir, kind);
    const entries = (await readdir(sourceRoot, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && entry.name !== "_drafts")
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const sourceDirectory = path.join(sourceRoot, entry.name);
      const destinationDirectory = path.join(assetRoot, kind, entry.name);
      await mkdir(destinationDirectory, { recursive: true });
      await copyFile(path.join(sourceDirectory, marker), path.join(destinationDirectory, marker));
      await copyFile(
        path.join(sourceDirectory, "eligibility.json"),
        path.join(destinationDirectory, "eligibility.json"),
      );
    }
  }
}

async function buildAll() {
  const distDir = path.resolve(artifactDir, "dist");
  const buildInfo = await createBuildInfo();
  await rm(distDir, { recursive: true, force: true });

  await esbuild({
    entryPoints: [path.resolve(artifactDir, "src/index.ts")],
    platform: "node",
    bundle: true,
    format: "esm",
    outdir: distDir,
    outExtension: { ".js": ".mjs" },
    logLevel: "info",
    // Some packages may not be bundleable, so we externalize them, we can add more here as needed.
    // Some of the packages below may not be imported or installed, but we're adding them in case they are in the future.
    // Examples of unbundleable packages:
    // - uses native modules and loads them dynamically (e.g. sharp)
    // - use path traversal to read files (e.g. @google-cloud/secret-manager loads sibling .proto files)
    external: [
      "*.node",
      "ws",
      "sharp",
      "better-sqlite3",
      "sqlite3",
      "canvas",
      "bcrypt",
      "argon2",
      "fsevents",
      "re2",
      "farmhash",
      "xxhash-addon",
      "bufferutil",
      "utf-8-validate",
      "ssh2",
      "cpu-features",
      "dtrace-provider",
      "isolated-vm",
      "lightningcss",
      "pg-native",
      "oracledb",
      "mongodb-client-encryption",
      "nodemailer",
      "handlebars",
      "knex",
      "typeorm",
      "protobufjs",
      "onnxruntime-node",
      "@tensorflow/*",
      "@prisma/client",
      "@mikro-orm/*",
      "@grpc/*",
      "@swc/*",
      "@babel/*",
      "@eslint/*",
      "@typescript-eslint/*",
      "eslint",
      "eslint-plugin-react",
      "eslint-plugin-react-hooks",
      "@aws-sdk/*",
      "@azure/*",
      "@google-cloud/*",
      "@google/*",
      "googleapis",
      "firebase-admin",
      "@parcel/watcher",
      "@sentry/profiling-node",
      "@sentry/node",
      "pg-boss",
      "prom-client",
      "@tree-sitter/*",
      "aws-sdk",
      "classic-level",
      "dd-trace",
      "ffi-napi",
      "grpc",
      "hiredis",
      "kerberos",
      "leveldown",
      "miniflare",
      "mysql2",
      "newrelic",
      "odbc",
      "piscina",
      "realm",
      "ref-napi",
      "rocksdb",
      "sass-embedded",
      "sequelize",
      "serialport",
      "snappy",
      "tinypool",
      "usb",
      "workerd",
      "wrangler",
      "zeromq",
      "zeromq-prebuilt",
      "playwright",
      "puppeteer",
      "puppeteer-core",
      "electron",
      "ws",
      "openai",
      "pdfkit",
      "pg-boss",
      "prom-client",
      "@sentry/node",
      "@sentry/tracing",
    ],
    // Source maps blow up bundle size (26 MB on top of 16 MB code) and have
    // tripped Replit's deploy bundler with "Socket closed 4500" during the
    // Bundle stage. Emit them only in dev; production deploys get a smaller,
    // minified bundle so the deployer doesn't choke.
    sourcemap: process.env.NODE_ENV === "production" ? false : "linked",
    minify: process.env.NODE_ENV === "production",
    plugins: [
      // pino relies on workers to handle logging, instead of externalizing it we use a plugin to handle it
      esbuildPluginPino({ transports: ["pino-pretty"] }),
    ],
    // Make sure packages that are cjs only (e.g. express) but are bundled continue to work in our esm output file
    banner: {
      js: `import { createRequire as __bannerCrReq } from 'node:module';
import __bannerPath from 'node:path';
import __bannerUrl from 'node:url';

globalThis.require = __bannerCrReq(import.meta.url);
globalThis.__filename = __bannerUrl.fileURLToPath(import.meta.url);
globalThis.__dirname = __bannerPath.dirname(globalThis.__filename);
    `,
    },
  });
  await copyEligibilityAssets(distDir);
  await writeFile(path.join(distDir, "build-info.json"), `${JSON.stringify(buildInfo)}\n`, "utf8");
}

buildAll().catch((err) => {
  console.error(err);
  process.exit(1);
});
