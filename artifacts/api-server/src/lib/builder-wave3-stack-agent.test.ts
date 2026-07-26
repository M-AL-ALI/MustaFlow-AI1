import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { detectRequiredStack } from "./ai";
import {
  CHECK_PROFILES,
  DEFERRED_CONTAINER_CHECK_MESSAGE,
  checksForLiveServerCapability,
  failedChecksEligibleForRepair,
  isContainerRequiredCheck,
} from "./check-profiles";
import {
  architectureChangeMessage,
  resolveInitialStackSelection,
  shouldAutoDetectStack,
} from "./stack-selection";

const here = dirname(fileURLToPath(import.meta.url));
const jobsSource = readFileSync(resolve(here, "jobs.ts"), "utf8");
const agentLoopSource = readFileSync(resolve(here, "agent-loop.ts"), "utf8");

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
  it("makes every container check non-mandatory when no live server is available", () => {
    for (const profile of Object.values(CHECK_PROFILES)) {
      const checks = checksForLiveServerCapability(profile.checks, false);
      for (const [index, check] of checks.entries()) {
        if (isContainerRequiredCheck(check)) {
          expect(check.required, `${profile.stack}:${check.id}`).toBe(false);
        } else {
          expect(check.required, `${profile.stack}:${check.id}`).toBe(
            profile.checks[index]?.required,
          );
        }
      }
    }
  });

  it("keeps all profile checks unchanged when a live server is available", () => {
    const profileChecks = CHECK_PROFILES["node-api"].checks;
    expect(checksForLiveServerCapability(profileChecks, true)).toBe(profileChecks);
  });

  it("passes per-project live-server capability into every agent loop path", () => {
    expect(jobsSource.match(/liveServerAvailable:/g)).toHaveLength(4);
    expect(jobsSource).toContain("liveServerAvailable: projectHasLiveServer()");
  });
});

describe("Builder Wave 3.1 container-check deferral", () => {
  it("classifies every configured check by its runner", () => {
    const classification = Object.fromEntries(
      Object.entries(CHECK_PROFILES).map(([stack, profile]) => [
        stack,
        profile.checks.map((check) => ({
          id: check.id,
          capability: isContainerRequiredCheck(check) ? "container-required" : "container-free",
        })),
      ]),
    );

    expect(classification).toEqual({
      "static-html": [
        { id: "html-syntax", capability: "container-free" },
        { id: "cross-file", capability: "container-free" },
      ],
      "react-vite": [
        { id: "typecheck", capability: "container-required" },
        { id: "build", capability: "container-required" },
      ],
      "node-api": [
        { id: "typecheck", capability: "container-required" },
        { id: "node-syntax", capability: "container-required" },
        { id: "server-start", capability: "container-required" },
      ],
      nextjs: [
        { id: "typecheck", capability: "container-required" },
        { id: "build", capability: "container-required" },
      ],
      "python-flask": [{ id: "py-compile", capability: "container-required" }],
      "python-fastapi": [{ id: "py-compile", capability: "container-required" }],
      "mobile-cross": [{ id: "mobile-structure", capability: "container-free" }],
    });
  });

  it("excludes deferred checks from repair while retaining genuine failures", () => {
    const checks = [
      {
        id: "typecheck",
        passed: false,
        message: DEFERRED_CONTAINER_CHECK_MESSAGE,
      },
      {
        id: "build",
        passed: true,
        message: DEFERRED_CONTAINER_CHECK_MESSAGE,
      },
      {
        id: "mobile-structure",
        passed: false,
        message: "Missing app.json",
      },
    ];

    expect(failedChecksEligibleForRepair(checks).map((check) => check.id)).toEqual([
      "mobile-structure",
    ]);
  });

  it("records unavailable container checks as deferred before in-process execution", () => {
    const deferralGuard = "isContainerRequiredCheck(c) && input.liveServerAvailable === false";
    expect(agentLoopSource).toContain(deferralGuard);
    expect(agentLoopSource.indexOf(deferralGuard)).toBeLessThan(
      agentLoopSource.indexOf('if (c.runner === "inprocess")'),
    );
    expect(agentLoopSource).toContain("passed: true");
    expect(agentLoopSource).toContain("skipped: deferredChecks.length");
  });

  it("uses only repair-eligible failures and emits an honest partial-validation result", () => {
    expect(jobsSource.match(/failedChecksEligibleForRepair\(/g)?.length).toBeGreaterThanOrEqual(3);
    expect(jobsSource).toContain(
      "Build completed with partial validation — live-server infrastructure was unavailable, so container-dependent checks were deferred.",
    );
    expect(jobsSource).toContain("validationWasPartial");
  });
});
