import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const ACCEPTANCE_DEPLOY_CONFIG_PATH = fileURLToPath(
  new URL("../wrangler.acceptance.jsonc", import.meta.url),
);
export const ACCEPTANCE_DEPLOY_MESSAGE_MAX_CHARACTERS = 160;

type AcceptanceDeploySpawner = (
  command: string,
  args: string[],
  options: {
    cwd: string;
    shell: false;
    stdio: "inherit";
  },
) => {
  error?: Error;
  status: number | null;
};

export type AcceptanceDeployDependencies = {
  nodeExecutable?: string;
  resolveWranglerEntry?: () => string;
  spawn?: AcceptanceDeploySpawner;
  writeError?: (message: string) => void;
};

export class AcceptanceDeployArgumentError extends Error {
  readonly code = "acceptance_deploy_arguments_invalid";

  constructor(message: string) {
    super(message);
    this.name = "AcceptanceDeployArgumentError";
  }
}

function containsControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint <= 31 || codePoint === 127);
  });
}

export function resolveDeclaredWranglerBin(): string {
  const require = createRequire(import.meta.url);
  const packageJsonPath = require.resolve("wrangler/package.json");
  const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
    bin?: string | Record<string, string>;
  };
  const declaredBin =
    typeof packageJson.bin === "string" ? packageJson.bin : packageJson.bin?.wrangler;
  if (declaredBin === undefined || declaredBin.trim().length === 0) {
    throw new Error("wrangler_declared_bin_missing");
  }
  return resolve(dirname(packageJsonPath), declaredBin);
}

export function parseAcceptanceDeployArguments(args: readonly string[]): {
  message?: string;
} {
  if (args.length === 0) {
    return {};
  }

  if (args.length !== 2 || args[0] !== "--message") {
    throw new AcceptanceDeployArgumentError(
      "Acceptance deployment accepts only one optional --message value.",
    );
  }

  const message = args[1].trim();
  const characterCount = Array.from(message).length;
  if (
    message.trim().length === 0 ||
    message.startsWith("-") ||
    characterCount > ACCEPTANCE_DEPLOY_MESSAGE_MAX_CHARACTERS ||
    containsControlCharacter(message)
  ) {
    throw new AcceptanceDeployArgumentError(
      `Acceptance deployment messages must contain 1-${ACCEPTANCE_DEPLOY_MESSAGE_MAX_CHARACTERS} plain characters.`,
    );
  }

  return { message };
}

export function runAcceptanceDeploy(
  args: readonly string[],
  dependencies: AcceptanceDeployDependencies = {},
): number {
  const writeError =
    dependencies.writeError ??
    ((message: string): void => {
      process.stderr.write(`${message}\n`);
    });

  let parsed: { message?: string };
  try {
    parsed = parseAcceptanceDeployArguments(args);
  } catch (error) {
    if (error instanceof AcceptanceDeployArgumentError) {
      writeError(error.message);
      return 2;
    }
    throw error;
  }

  const resolveWranglerEntry = dependencies.resolveWranglerEntry ?? resolveDeclaredWranglerBin;
  let wranglerEntry: string;
  try {
    wranglerEntry = resolveWranglerEntry();
  } catch {
    writeError("Acceptance deployment could not locate Wrangler's declared executable.");
    return 1;
  }
  const wranglerArgs = [wranglerEntry, "deploy", "--config", ACCEPTANCE_DEPLOY_CONFIG_PATH];
  if (parsed.message !== undefined) {
    wranglerArgs.push("--message", parsed.message);
  }

  const spawn = dependencies.spawn ?? (spawnSync as AcceptanceDeploySpawner);
  const result = spawn(dependencies.nodeExecutable ?? process.execPath, wranglerArgs, {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    shell: false,
    stdio: "inherit",
  });

  if (result.error !== undefined || result.status === null) {
    writeError("Acceptance deployment could not start Wrangler.");
    return 1;
  }
  return result.status;
}

const entryPath = process.argv[1];
if (entryPath !== undefined && import.meta.url === pathToFileURL(entryPath).href) {
  process.exitCode = runAcceptanceDeploy(process.argv.slice(2));
}
