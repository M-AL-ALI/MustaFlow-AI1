import { readFile, readdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ACCEPTANCE_DEPLOY_CONFIG_PATH,
  ACCEPTANCE_DEPLOY_MESSAGE_MAX_CHARACTERS,
  parseAcceptanceDeployArguments,
  resolveDeclaredWranglerBin,
  runAcceptanceDeploy,
} from "../scripts/deploy-acceptance";

type AcceptanceWranglerConfig = {
  name: string;
  env?: unknown;
  vars?: Record<string, string>;
  queues: {
    consumers: Array<{
      queue: string;
      max_batch_size: number;
      max_batch_timeout: number;
      max_retries: number;
      max_concurrency: number;
    }>;
  };
};

async function readConfig(): Promise<{ config: AcceptanceWranglerConfig; source: string }> {
  const source = await readFile(
    fileURLToPath(new URL("../wrangler.acceptance.jsonc", import.meta.url)),
    "utf8",
  );
  return {
    source,
    config: JSON.parse(source.replace(/,\s*([}\]])/gu, "$1")) as AcceptanceWranglerConfig,
  };
}

async function readPackageScripts(): Promise<Record<string, string>> {
  const source = await readFile(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8");
  return (JSON.parse(source) as { scripts: Record<string, string> }).scripts;
}

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const guardedAcceptanceDeployPath = resolve(
  repositoryRoot,
  "artifacts/nabuflow-runtime-worker/scripts/deploy-acceptance.ts",
);

async function repositoryExecutableSources(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === ".git" || entry.name === "node_modules" || entry.name === "tmp") continue;
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await repositoryExecutableSources(path)));
      continue;
    }
    if (
      entry.name === "package.json" ||
      (directory.split(/[\\/]/u).includes("scripts") &&
        /\.(?:cjs|js|mjs|ps1|sh|ts)$/u.test(entry.name))
    ) {
      files.push(path);
    }
  }
  return files;
}

describe("Acceptance Provisioner deployment contract", () => {
  it("binds Worker version metadata for durable-operation dispatch", async () => {
    const { source } = await readConfig();

    expect(source).toMatch(/"version_metadata"\s*:\s*\{\s*"binding"\s*:\s*"CF_VERSION_METADATA"/u);
  });

  it("pins the exact canonical Worker identity without an environment suffix path", async () => {
    const { config, source } = await readConfig();

    expect(config.name).toBe("nabuflow-acceptance-provisioner-staging");
    expect(config.name).not.toMatch(/-staging-staging$/u);
    expect(config.env).toBeUndefined();
    expect(source).not.toMatch(/\blegacy_env\b|--env\s+staging/u);
  });

  it("never shadows cleanup provider scopes with placeholder config values", async () => {
    const { config, source } = await readConfig();
    const hiddenProviderBindings = [
      "ACCEPTANCE_NEON_ORGANIZATION_ID",
      "ACCEPTANCE_STRIPE_SANDBOX_ID",
      "ACCEPTANCE_FLY_ORGANIZATION_SLUG",
      "ACCEPTANCE_FLY_IMAGE_REF",
    ];

    for (const binding of hiddenProviderBindings) {
      expect(config.vars).not.toHaveProperty(binding);
    }
    expect(source).not.toMatch(/UNCONFIGURED_|unconfigured-/u);
  });

  it("wires the sole acceptance deploy script to the guarded entrypoint", async () => {
    const scripts = await readPackageScripts();
    const acceptanceScripts = Object.entries(scripts).filter(([name, command]) =>
      `${name} ${command}`.includes("acceptance"),
    );

    expect(acceptanceScripts).toEqual([["deploy:acceptance", "tsx scripts/deploy-acceptance.ts"]]);
  });

  it("rejects repository-wide direct acceptance deploy and generated-config bypasses", async () => {
    const directDeploy =
      /(?:["'`]deploy["'`]\s*,\s*["'`]--config["'`]|\bwrangler(?:\.cmd)?\s+deploy\b)/u;
    const acceptanceTarget = /wrangler\.acceptance|nabuflow-acceptance-provisioner/u;
    const generatedAcceptanceConfig = new RegExp(
      [
        "wrangler\\.acceptance\\.(?:open|generated|tmp)",
        ["build", "ProvisionerConfig"].join(""),
        "replaceJsonString[\\s\\S]{0,2000}ACCEPTANCE_STAGING_ENABLED",
      ].join("|"),
      "u",
    );
    const sources = await repositoryExecutableSources(repositoryRoot);
    const directBypasses: string[] = [];
    const generatedConfigBypasses: string[] = [];

    for (const path of sources) {
      const source = await readFile(path, "utf8");
      const displayPath = relative(repositoryRoot, path).replaceAll("\\", "/");
      if (path.endsWith("package.json")) {
        const scripts = (JSON.parse(source) as { scripts?: Record<string, string> }).scripts ?? {};
        for (const [name, command] of Object.entries(scripts)) {
          const declaration = `${name} ${command}`;
          if (acceptanceTarget.test(declaration) && directDeploy.test(command)) {
            directBypasses.push(`${displayPath}#${name}`);
          }
        }
      } else if (
        path !== guardedAcceptanceDeployPath &&
        acceptanceTarget.test(source) &&
        directDeploy.test(source)
      ) {
        directBypasses.push(displayPath);
      }
      if (generatedAcceptanceConfig.test(source)) {
        generatedConfigBypasses.push(displayPath);
      }
    }

    expect(directBypasses).toEqual([]);
    expect(generatedConfigBypasses).toEqual([]);
  });

  it("always spawns Wrangler without a shell and with the fixed acceptance config", () => {
    const calls: Array<{
      args: string[];
      command: string;
      options: { cwd: string; shell: false; stdio: "inherit" };
    }> = [];

    const status = runAcceptanceDeploy(["--message", "cost-control cutover"], {
      nodeExecutable: "fixed-node",
      resolveWranglerEntry: () => "fixed-wrangler-entry",
      spawn: (command, args, options) => {
        calls.push({ command, args, options });
        return { status: 0 };
      },
    });

    expect(status).toBe(0);
    expect(calls).toEqual([
      {
        command: "fixed-node",
        args: [
          "fixed-wrangler-entry",
          "deploy",
          "--config",
          ACCEPTANCE_DEPLOY_CONFIG_PATH,
          "--message",
          "cost-control cutover",
        ],
        options: {
          cwd: fileURLToPath(new URL("..", import.meta.url)),
          shell: false,
          stdio: "inherit",
        },
      },
    ]);
  });

  it("resolves the installed package's declared Wrangler executable without deploying", async () => {
    const require = createRequire(import.meta.url);
    const packageJsonPath = require.resolve("wrangler/package.json");
    const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8")) as {
      bin: Record<string, string>;
    };
    const expectedBin = resolve(dirname(packageJsonPath), packageJson.bin.wrangler);

    expect(packageJson.bin.wrangler).toBe("./bin/wrangler.js");
    expect(resolveDeclaredWranglerBin()).toBe(expectedBin);
    expect(resolveDeclaredWranglerBin()).toMatch(/[\\/]bin[\\/]wrangler\.js$/u);
  });

  it("refuses environment, name, positional, and unknown arguments before spawning", () => {
    const refusedArguments = [
      ["--env", "staging"],
      ["--name", "nabuflow-acceptance-provisioner-staging-staging"],
      ["--message=unbounded"],
      ["--unknown"],
      ["staging"],
      ["--message", "valid", "--env", "staging"],
    ];

    for (const args of refusedArguments) {
      let spawnCount = 0;
      const errors: string[] = [];
      const status = runAcceptanceDeploy(args, {
        resolveWranglerEntry: () => "fixed-wrangler-entry",
        spawn: () => {
          spawnCount += 1;
          return { status: 0 };
        },
        writeError: (message) => errors.push(message),
      });

      expect(status).toBe(2);
      expect(spawnCount).toBe(0);
      expect(errors).toHaveLength(1);
      expect(errors[0]).not.toContain(args.join(" "));
    }
  });

  it("bounds and sanitizes the optional deployment message before spawning", () => {
    expect(parseAcceptanceDeployArguments([])).toEqual({});
    expect(parseAcceptanceDeployArguments(["--message", "bounded message"])).toEqual({
      message: "bounded message",
    });
    expect(parseAcceptanceDeployArguments(["--message", "  bounded message  "])).toEqual({
      message: "bounded message",
    });
    expect(() => parseAcceptanceDeployArguments(["--message", ""])).toThrow();
    expect(() => parseAcceptanceDeployArguments(["--message", "--env"])).toThrow();
    expect(() => parseAcceptanceDeployArguments(["--message", "line\nbreak"])).toThrow();
    expect(() =>
      parseAcceptanceDeployArguments([
        "--message",
        "x".repeat(ACCEPTANCE_DEPLOY_MESSAGE_MAX_CHARACTERS + 1),
      ]),
    ).toThrow();
  });

  it("serializes acceptance work at the queue boundary with bounded platform retries", async () => {
    const { config } = await readConfig();

    expect(config.queues.consumers).toEqual([
      {
        queue: "nabuflow-acceptance-operations-staging",
        max_batch_size: 1,
        max_batch_timeout: 5,
        max_retries: 3,
        max_concurrency: 1,
      },
    ]);
  });
});
