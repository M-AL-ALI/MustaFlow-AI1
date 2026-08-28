import { describe, expect, it } from "vitest";
import { StartupHealthState } from "./startup-health-state";

describe("startup health state", () => {
  it("is unknown until startup migrations report a terminal result", () => {
    const state = new StartupHealthState();

    expect(state.read()).toEqual({ migrations: "unknown", failureSteps: [] });

    state.recordMigrations("ok");
    expect(state.read()).toEqual({ migrations: "ok", failureSteps: [] });
  });

  it("records a failed migration terminal without changing response policy", () => {
    const state = new StartupHealthState();

    state.recordMigrations("error", ["migrate-one"]);

    expect(state.read()).toEqual({ migrations: "error", failureSteps: ["migrate-one"] });
  });
});
