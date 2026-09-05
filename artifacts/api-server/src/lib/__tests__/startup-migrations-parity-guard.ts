type Environment = Readonly<Record<string, string | undefined>>;

export type DisposableStartupMigrationDatabase = Readonly<{ connectionString: string }>;

const LOCAL_TARGET_HOSTS = new Set(["127.0.0.1", "[::1]"]);
const DISPOSABLE_DATABASE_NAME = /^mustaflow_parity_disposable_[a-z0-9]{8,32}$/u;

function unsafeTarget(): never {
  // Never include URLs or credentials in diagnostic errors.
  throw new Error("startup_migrations_parity_unsafe_database_target");
}

function localDatabaseIdentity(connectionString: string | undefined): string | null {
  if (!connectionString) return null;
  try {
    const url = new URL(connectionString);
    if (!["postgres:", "postgresql:"].includes(url.protocol)) return null;
    if (!LOCAL_TARGET_HOSTS.has(url.hostname) && url.hostname !== "localhost") return null;
    return `${Number(url.port || "5432")}/${decodeURIComponent(url.pathname.slice(1))}`;
  } catch {
    return null;
  }
}

/** Pure opt-in gate. No ambient URL fallback, connection, or pool creation. */
export function resolveDisposableStartupMigrationDatabase(
  environment: Environment,
): DisposableStartupMigrationDatabase | null {
  if (environment.ALLOW_DESTRUCTIVE_STARTUP_MIGRATIONS_PARITY !== "1") return null;
  if (
    environment.NODE_ENV === "production" ||
    environment.REPL_ID?.trim() ||
    environment.REPLIT_DEPLOYMENT?.trim()
  ) {
    throw new Error("startup_migrations_parity_production_environment_forbidden");
  }
  const connectionString = environment.TEST_DATABASE_URL?.trim();
  if (!connectionString) {
    throw new Error("startup_migrations_parity_disposable_database_required");
  }

  let url: URL;
  let databaseName: string;
  try {
    url = new URL(connectionString);
    databaseName = decodeURIComponent(url.pathname.slice(1));
  } catch {
    return unsafeTarget();
  }
  if (
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    !LOCAL_TARGET_HOSTS.has(url.hostname) ||
    !url.port ||
    Number(url.port) < 1024 ||
    Number(url.port) > 65535 ||
    !url.username ||
    !DISPOSABLE_DATABASE_NAME.test(databaseName) ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    return unsafeTarget();
  }
  // User/password differences and localhost aliases do not make a database disposable.
  if (localDatabaseIdentity(environment.DATABASE_URL) === localDatabaseIdentity(connectionString)) {
    throw new Error("startup_migrations_parity_ambient_database_forbidden");
  }
  return Object.freeze({ connectionString });
}
