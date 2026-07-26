import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { detectRequiredStack } from "./ai";
import { CHECK_PROFILES, checksForLiveServerCapability } from "./check-profiles";
import {
  architectureChangeMessage,
  resolveInitialStackSelection,
  shouldAutoDetectStack,
} from "./stack-selection";

const here = dirname(fileURLToPath(import.meta.url));
const jobsSource = readFileSync(resolve(here, "jobs.ts"), "utf8");

describe("Builder Wave 3 stack authority", () => {
  it("keeps an explicit React/Vite selection authoritative", () => {
    const selection = resolveInitialStackSelection({
      requestedStack: "react-vite",
      isMobilePlatform: false,
    });

    expect(selection).toEqual({
      stack: "react-vite",
      projectFormat: "react-vite",
      stackLocked: true,
    });
    expect(
      shouldAutoDetectStack({
        jobKind: "build",
        isMobileProject: false,
        stackLocked: selection.stackLocked,
      }),
    ).toBe(false);
  });

  it("keeps an explicit server stack authoritative", () => {
    const selection = resolveInitialStackSelection({
      requestedStack: "node-api",
      isMobilePlatform: false,
    });

    expect(selection).toEqual({
      stack: "node-api",
      projectFormat: "static-html",
      stackLocked: true,
    });
    expect(
      shouldAutoDetectStack({
        jobKind: "build",
        isMobileProject: false,
        stackLocked: selection.stackLocked,
      }),
    ).toBe(false);
  });

  it("retains auto-detection only when the creation request omitted stack", () => {
    const selection = resolveInitialStackSelection({
      isMobilePlatform: false,
    });

    expect(selection.stackLocked).toBe(false);
    expect(
      shouldAutoDetectStack({
        jobKind: "build",
        isMobileProject: false,
        stackLocked: selection.stackLocked,
      }),
    ).toBe(true);
  });

  it("does not classify negated backend requirements as node-api", async () => {
    await expect(
      detectRequiredStack("No database, no authentication, no external APIs."),
    ).resolves.not.toBe("node-api");
    await expect(
      detectRequiredStack(
        "Build a React Vite dashboard with no database, no authentication, and no external APIs.",
      ),
    ).resolves.toBe("react-vite");
  });

  it("keeps normal automatic backend detection working", async () => {
    await expect(
      detectRequiredStack("Build a REST API with PostgreSQL authentication and user accounts."),
    ).resolves.toBe("node-api");
  });

  it("records both sides of an automatic architecture change", () => {
    expect(
      architectureChangeMessage({
        previousStack: "react-vite",
        previousFormat: "react-vite",
        nextStack: "node-api",
        nextFormat: "static-html",
      }),
    ).toBe(
      "Auto architecture changed: stack react-vite -> node-api; format react-vite -> static-html.",
    );
    expect(jobsSource).toContain('"architecture_changed"');
    expect(jobsSource).toContain("previousStack");
    expect(jobsSource).toContain("nextStack");
  });

  it("wires the persisted lock into the jobs auto-detection gate", () => {
    expect(jobsSource).toContain("shouldAutoDetectStack({");
    expect(jobsSource).toContain("stackLocked: project.stackLocked");
  });
});

describe("Builder Wave 3 live-server capability", () => {
  it("makes healthz non-mandatory when no live server is available", () => {
    const checks = checksForLiveServerCapability(CHECK_PROFILES["node-api"].checks, false);
    const healthz = checks.find((check) => check.id === "server-start");

    expect(healthz?.required).toBe(false);
    expect(checks.some((check) => check.required && check.id === "server-start")).toBe(false);
  });

  it("keeps healthz mandatory when a live server is available", () => {
    const checks = checksForLiveServerCapability(CHECK_PROFILES["node-api"].checks, true);
    expect(checks.find((check) => check.id === "server-start")?.required).toBe(true);
  });

  it("passes per-project live-server capability into every agent loop path", () => {
    expect(jobsSource.match(/liveServerAvailable:/g)).toHaveLength(3);
    expect(jobsSource).toContain("isContainerLayerConfigured() && Boolean(project.containerId)");
  });
});
