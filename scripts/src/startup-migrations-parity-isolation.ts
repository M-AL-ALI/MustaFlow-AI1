import { spawn } from "node:child_process";

const SCRATCH_DATABASE_PATTERN = /^parity_scratch(?:_[a-z0-9]+)?$/;
const CHILD_TIMEOUT_MS = 20 * 60 * 1000;
const REDACTED_DATABASE_ENV_NAMES = new Set([
  "DATABASE_URL",
  "TEST_DATABASE_URL",
  "PGHOST",
  "PGDATABASE",
  "PGUSER",
  "PGPASSWORD",
  "PGPORT",
  "PARITY_TEST_DATABASE_URL",
]);

export type ParityIsolationErrorCode =
  | "parity_database_url_missing"
  | "parity_database_url_malformed"
  | "parity_database_name_missing"
  | "parity_database_name_refused"
  | "parity_check_failed";

export class ParityIsolationError extends Error {
  constructor(
    readonly code: ParityIsolationErrorCode,
    readonly host: string,
    readonly databaseName: string,
  ) {
    super(`${code} host=${host} dbname=${databaseName}`);
    this.name = "ParityIsolationError";
  }
}

export interface ParityDatabaseTarget {
  readonly connectionString: string;
  readonly host: string;
  readonly databaseName: string;
}

export interface ParityIsolationConnector {
  setup(target: ParityDatabaseTarget): Promise<void>;
  check(target: ParityDatabaseTarget): Promise<void>;
  teardown(target: ParityDatabaseTarget): Promise<void>;
}

export interface RunParityIsolationOptions {
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly connector: ParityIsolationConnector;
  readonly log: (line: string) => void;
}

function refusal(code: ParityIsolationErrorCode, host: string, databaseName: string): never {
  throw new ParityIsolationError(code, host, databaseName);
}

export function parseParityDatabaseTarget(raw: string | undefined): ParityDatabaseTarget {
  if (raw === undefined || raw.trim() === "") {
    return refusal("parity_database_url_missing", "<unavailable>", "<missing>");
  }

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return refusal("parity_database_url_malformed", "<unavailable>", "<unavailable>");
  }

  if (!["postgres:", "postgresql:"].includes(parsed.protocol) || parsed.hostname === "") {
    return refusal(
      "parity_database_url_malformed",
      parsed.hostname || "<unavailable>",
      "<unavailable>",
    );
  }

  const encodedName = parsed.pathname.replace(/^\//, "");
  if (encodedName === "" || encodedName.includes("/")) {
    return refusal("parity_database_name_missing", parsed.hostname, "<missing>");
  }

  let databaseName: string;
  try {
    databaseName = decodeURIComponent(encodedName);
  } catch {
    return refusal("parity_database_url_malformed", parsed.hostname, "<unavailable>");
  }

  if (!SCRATCH_DATABASE_PATTERN.test(databaseName)) {
    return refusal("parity_database_name_refused", parsed.hostname, databaseName);
  }

  return {
    connectionString: raw,
    host: parsed.hostname,
    databaseName,
  };
}

function targetSuffix(target: Pick<ParityDatabaseTarget, "host" | "databaseName">): string {
  return `host=${target.host} dbname=${target.databaseName}`;
}

export async function runParityIsolation({
  environment,
  connector,
  log,
}: RunParityIsolationOptions): Promise<void> {
  let target: ParityDatabaseTarget;
  try {
    target = parseParityDatabaseTarget(environment.PARITY_TEST_DATABASE_URL);
  } catch (error) {
    if (error instanceof ParityIsolationError) {
      log(`${error.code} host=${error.host} dbname=${error.databaseName}`);
    }
    throw error;
  }

  const suffix = targetSuffix(target);
  log(`parity_setup_start ${suffix}`);
  await connector.setup(target);

  try {
    log(`parity_check_start ${suffix}`);
    await connector.check(target);
    log(`parity_check_pass ${suffix}`);
  } catch {
    const error = new ParityIsolationError("parity_check_failed", target.host, target.databaseName);
    log(error.message);
    throw error;
  } finally {
    log(`parity_teardown_start ${suffix}`);
    await connector.teardown(target);
    log(`parity_teardown_complete ${suffix}`);
  }
}

function sanitizedChildEnvironment(target: ParityDatabaseTarget): NodeJS.ProcessEnv {
  const childEnvironment: NodeJS.ProcessEnv = {};
  for (const name of Object.keys(process.env)) {
    if (REDACTED_DATABASE_ENV_NAMES.has(name)) continue;
    const value = process.env[name];
    if (value !== undefined) childEnvironment[name] = value;
  }

  // The legacy application migration module accepts DATABASE_URL. The standalone
  // parent never reads an ambient value: it supplies only the already-validated
  // scratch target to this isolated child.
  childEnvironment.DATABASE_URL = target.connectionString;
  return childEnvironment;
}

function runExistingParityCheck(target: ParityDatabaseTarget): Promise<void> {
  return new Promise((resolve, reject) => {
    const command = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
    const child = spawn(
      command,
      [
        "--filter",
        "@workspace/api-server",
        "exec",
        "vitest",
        "run",
        "src/lib/__tests__/startup-migrations-parity.test.ts",
        "--reporter=basic",
      ],
      {
        cwd: process.cwd(),
        env: sanitizedChildEnvironment(target),
        stdio: ["ignore", "ignore", "ignore"],
        windowsHide: true,
      },
    );

    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error("parity_child_timeout"));
    }, CHILD_TIMEOUT_MS);

    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      if (code === 0) resolve();
      else reject(new Error(`parity_child_exit code=${String(code)} signal=${String(signal)}`));
    });
  });
}

export const existingParityCheckConnector: ParityIsolationConnector = {
  async setup() {
    // The parity test owns its scratch-only fixture setup.
  },
  async check(target) {
    await runExistingParityCheck(target);
  },
  async teardown() {
    // The isolated child owns connection teardown; the database itself is scratch-only.
  },
};

async function main(): Promise<void> {
  await runParityIsolation({
    environment: process.env,
    connector: existingParityCheckConnector,
    log: (line) => console.log(line),
  });
}

const invokedPath = process.argv[1]?.replaceAll("\\", "/");
if (invokedPath?.endsWith("/startup-migrations-parity-isolation.ts")) {
  main().catch((error: unknown) => {
    if (!(error instanceof ParityIsolationError)) {
      console.error("parity_check_failed host=<unavailable> dbname=<unavailable>");
    }
    process.exitCode = 1;
  });
}
