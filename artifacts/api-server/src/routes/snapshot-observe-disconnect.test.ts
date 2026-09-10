import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express, { type Response } from "express";
import request from "supertest";

const mocks = vi.hoisted(() => ({ connect: vi.fn() }));
vi.mock("@workspace/db", async (original) => ({
  ...(await original<typeof import("@workspace/db")>()),
  pool: { connect: mocks.connect },
}));
vi.mock("../lib/agent-senses", () => ({ takeScreenshot: vi.fn() }));
vi.mock("../lib/builder", () => ({ runConversePipeline: vi.fn() }));
vi.mock("../lib/auth", () => ({ requireProjectOwnership: vi.fn(), checkProjectAccess: vi.fn() }));
vi.mock("../lib/support-access", () => ({ findLiveSupportGrant: vi.fn() }));
vi.mock("../lib/tenant-runtime", () => ({ tenantRuntimeProvider: {} }));
vi.mock("../lib/livePreviewProxy", () => ({
  shouldRouteToLivePreview: () => true,
  resolveCloudflareLivePreviewLaunchUrl: vi.fn(),
}));
vi.mock("../lib/zero-intent-admission", () => ({ governIntentAdmission: vi.fn() }));
vi.mock("../lib/zero-intent-receipt-store", () => ({ intentReceiptStore: {} }));
vi.mock("../lib/zero-terminal-persistence", () => ({
  persistZeroTerminal: vi.fn(),
  zeroTerminalRef: vi.fn(),
}));
vi.mock("../lib/nabuflow-billing", () => ({ nabuflowGateHttpError: vi.fn() }));

import { createSnapshotObserveRouter } from "./snapshot-observe";
import {
  holdResponseProjectLifecycleSession,
  requireActiveProjectLifecycleSession,
  withActiveProjectLifecycle,
} from "../lib/project-lifecycle";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("TENANT_RUNTIME_PROVIDER", "cloudflare");
});
afterEach(() => vi.unstubAllEnvs());

describe("snapshot disconnect lifecycle retention", () => {
  it.each(["capture", "persistence"] as const)(
    "holds admission across socket close during %s",
    async (phase) => {
      let locked = false;
      let connections = 0;
      const denied = deferred();
      const firstReleased = deferred();
      const unlock = vi.fn();
      mocks.connect.mockImplementation(async () => {
        const index = ++connections;
        let owns = false;
        return {
          query: vi.fn(async (sql: string) => {
            if (sql.includes("pg_try_advisory_lock")) {
              if (locked) {
                denied.resolve();
                return { rows: [{ acquired: false }] };
              }
              locked = true;
              owns = true;
              return { rows: [{ acquired: true }] };
            }
            if (sql.includes("pg_advisory_unlock")) {
              if (!owns) throw new Error("fixture unlock without ownership");
              owns = false;
              locked = false;
              unlock(index);
              return { rows: [{ pg_advisory_unlock: true }] };
            }
            if (sql.startsWith("SELECT id FROM projects")) return { rows: [{ id: 81 }] };
            throw new Error("Unexpected fixture SQL");
          }),
          release: vi.fn(() => {
            if (index === 1) firstReleased.resolve();
          }),
        };
      });

      const entered = deferred();
      const settle = deferred();
      let response!: Response;
      const gate = async () => {
        entered.resolve();
        await settle.promise;
      };
      const app = express();
      app.use(express.json());
      app.use("/projects/:id/observe/snapshot", (req, res, next) => {
        req.userId = "owner";
        response = res;
        void requireActiveProjectLifecycleSession(req, res, next).catch(next);
      });
      const completion = vi.fn(async () => {
        expect(unlock).not.toHaveBeenCalled();
        if (phase === "persistence") await gate();
        return { ok: true };
      });
      app.use(
        createSnapshotObserveRouter(
          {
            loadProject: async () => ({
              id: 81,
              name: "Disconnect fixture",
              ownerId: "owner",
              status: "ready",
              builderMode: "agentic",
              agentMode: "eco",
              containerId: "runtime-81",
              containerStatus: "running",
              runtimePort: 3000,
              stack: "node",
            }),
            resolveCloudflarePreview: async () => "https://capture.invalid/",
            capture: async () => {
              if (phase === "capture") await gate();
              expect(unlock).not.toHaveBeenCalled();
              return {
                ok: true,
                finalUrl: "https://capture.invalid/",
                base64: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString("base64"),
              };
            },
            complete: completion,
            holdLifecycle: holdResponseProjectLifecycleSession,
          },
          (_req, _res, next) => next(),
        ),
      );
      const flight = request(app)
        .post("/projects/81/observe/snapshot")
        .send({
          path: "/",
          previewSource: "server",
          viewport: { width: 1280, height: 800 },
        })
        .then(
          () => null,
          (error) => error,
        );

      await entered.promise;
      const closed = new Promise<void>((done) => response.once("close", () => done()));
      response.destroy();
      await closed;
      expect(unlock).not.toHaveBeenCalled();
      let competitorRan = false;
      const competitor = withActiveProjectLifecycle(81, async () => {
        competitorRan = true;
      });
      await denied.promise;
      expect(competitorRan).toBe(false);
      settle.resolve();
      await firstReleased.promise;
      await competitor;
      expect(competitorRan).toBe(true);
      expect(completion).toHaveBeenCalledOnce();
      expect(unlock.mock.calls.map((call) => call[0])).toEqual([1, 2]);
      expect(await flight).not.toBeNull();
    },
  );
});
