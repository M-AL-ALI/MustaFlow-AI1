export type StartupCheckStatus = "unknown" | "ok" | "error";

export type StartupHealthSnapshot = {
  migrations: StartupCheckStatus;
};

/**
 * In-memory startup facts for the DB-independent health response.
 *
 * The health route only reads this cached state. It never waits for startup
 * work and never queries the database or a provider.
 */
export class StartupHealthState {
  private migrations: StartupCheckStatus = "unknown";

  read(): StartupHealthSnapshot {
    return { migrations: this.migrations };
  }

  recordMigrations(status: Exclude<StartupCheckStatus, "unknown">): void {
    this.migrations = status;
  }
}

export const startupHealthState = new StartupHealthState();
