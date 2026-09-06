const DISPOSABLE_DATABASE_PATTERN = /^ora_gate_disposable_[a-f0-9]{16}$/u;

export const VITEST_DATABASE_URL_ENV = "NABUFLOW_VITEST_DATABASE_URL";
export const VITEST_DATABASE_ENABLED_ENV = "NABUFLOW_VITEST_DATABASE_ENABLED";
export const VITEST_DATABASE_BASELINE_ENV = "NABUFLOW_VITEST_DATABASE_URL_BASELINE";

export function resolveVitestDatabaseUrl(
  environment: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const value = environment[VITEST_DATABASE_URL_ENV];
  if (!value) return undefined;

  try {
    const url = new URL(value);
    const database = decodeURIComponent(url.pathname.slice(1));
    const port = url.port ? Number(url.port) : 5432;
    if (
      !["postgres:", "postgresql:"].includes(url.protocol) ||
      url.hostname !== "127.0.0.1" ||
      !DISPOSABLE_DATABASE_PATTERN.test(database) ||
      url.search !== "" ||
      url.hash !== "" ||
      !Number.isInteger(port) ||
      port < 1 ||
      port > 65535
    ) {
      throw new Error("unsafe target");
    }
    return value;
  } catch {
    throw new Error(
      `${VITEST_DATABASE_URL_ENV} must target 127.0.0.1 and an ora_gate_disposable_<16 hex> database`,
    );
  }
}

export function configureVitestDatabase(environment: NodeJS.ProcessEnv = process.env): void {
  const databaseUrl = resolveVitestDatabaseUrl(environment);
  if (databaseUrl) {
    environment.DATABASE_URL = databaseUrl;
    environment[VITEST_DATABASE_ENABLED_ENV] = "true";
    environment[VITEST_DATABASE_BASELINE_ENV] = databaseUrl;
    return;
  }

  delete environment.DATABASE_URL;
  environment[VITEST_DATABASE_ENABLED_ENV] = "false";
  environment[VITEST_DATABASE_BASELINE_ENV] = "";
}
