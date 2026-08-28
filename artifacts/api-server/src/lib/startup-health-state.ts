export type StartupCheckStatus = "unknown" | "ok" | "error";

export type StartupHealthSnapshot = {
  migrations: StartupCheckStatus;
  failureSteps: readonly string[];
};

/**
 * In-memory startup facts for the DB-independent health response.
 *
 * The health route only reads this cached state. It never waits for startup
 * work and never queries the database or a provider.
 */
export class StartupHealthState {
  private migrations: StartupCheckStatus = "unknown";
  private failureSteps: readonly string[] = [];

  read(): StartupHealthSnapshot {
    return { migrations: this.migrations, failureSteps: [...this.failureSteps] };
  }

  recordMigrations(
    status: Exclude<StartupCheckStatus, "unknown">,
    failureSteps: readonly string[] = [],
  ): void {
    this.migrations = status;
    this.failureSteps = status === "error" ? failureSteps.slice(0, 10) : [];
  }
}

export const startupHealthState = new StartupHealthState();
