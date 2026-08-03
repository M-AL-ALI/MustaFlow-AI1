import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  selectResults: [] as unknown[][],
  insertedSecret: null as Record<string, unknown> | null,
  updatedSecret: null as Record<string, unknown> | null,
  deletedIds: [] as number[],
}));

const tables = vi.hoisted(() => ({
  secretsTable: {
    id: "secret.id",
    projectId: "secret.projectId",
    name: "secret.name",
    environment: "secret.environment",
    createdAt: "secret.createdAt",
  },
  secretAuditLogTable: { id: "audit.id" },
  projectFilesTable: { path: "file.path", projectId: "file.projectId" },
  projectsTable: { id: "project.id" },
  orgMembersTable: { role: "member.role" },
  containerLogsTable: { id: "log.id" },
  agentTasksTable: { id: "task.id", projectId: "task.projectId", createdAt: "task.createdAt" },
  taskEventsTable: { id: "event.id" },
}));

vi.mock("drizzle-orm", () => ({
  and: (...parts: unknown[]) => ({ and: parts }),
  desc: (value: unknown) => value,
  eq: (column: unknown, value: unknown) => ({ column, value }),
  sql: (parts: TemplateStringsArray) => ({ sql: parts.join("") }),
}));

vi.mock("@workspace/db", () => {
  const select = () => {
    const query = {
      from: () => query,
      where: () => query,
      orderBy: () => Promise.resolve(state.selectResults.shift() ?? []),
      then: (resolve: (value: unknown[]) => unknown, reject: (error: unknown) => unknown) =>
        Promise.resolve(state.selectResults.shift() ?? []).then(resolve, reject),
    };
    return query;
  };

  return {
    ...tables,
    db: {
      select,
      insert: (table: unknown) => ({
        values: (values: Record<string, unknown>) => {
          if (table !== tables.secretsTable) return Promise.resolve();
          state.insertedSecret = values;
          return { returning: () => Promise.resolve(state.selectResults.shift() ?? []) };
        },
      }),
      update: () => ({
        set: (values: Record<string, unknown>) => {
          state.updatedSecret = values;
          return {
            where: () => ({ returning: () => Promise.resolve(state.selectResults.shift() ?? []) }),
          };
        },
      }),
      delete: () => ({
        where: (condition: { value?: number }) => {
          if (typeof condition.value === "number") state.deletedIds.push(condition.value);
          return Promise.resolve();
        },
      }),
    },
  };
});

vi.mock("../lib/auth", () => ({
  requireProjectOwnership: (
    req: express.Request & { userId?: string },
    _res: express.Response,
    next: express.NextFunction,
  ) => {
    req.userId = "owner-1";
    next();
  },
}));
vi.mock("../lib/encryption", () => ({
  encryptionService: {
    encrypt: (value: string) => `encrypted:${value}`,
    decrypt: () => {
      throw new Error("response serialization must never decrypt");
    },
    isDevelopmentOnly: false,
  },
}));
vi.mock("../lib/container", () => ({
  execInContainer: vi.fn(),
  restartContainerWithSecrets: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../lib/container-secrets", () => ({
  getContainerSecretMap: vi.fn().mockResolvedValue({}),
  getProjectSecretLiterals: vi.fn().mockResolvedValue([]),
  invalidateContainerSecretCache: vi.fn(),
}));
vi.mock("../lib/agent-loop", () => ({ invalidateAgentSecretRegistry: vi.fn() }));
vi.mock("../lib/knowledge", () => ({ writeKnowledge: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../lib/event-bus", () => ({
  publishSecretEvent: vi.fn(),
  publishTaskEvent: vi.fn(),
  subscribeSecretEvents: vi.fn(() => () => undefined),
}));
vi.mock("../lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import secretsRouter from "./secrets";

const timestamp = new Date("2026-08-03T12:00:00.000Z");
const row = (overrides: Record<string, unknown> = {}) => ({
  id: 41,
  projectId: 7,
  name: "API_TOKEN",
  valueEncrypted: "ciphertext-never-returned",
  environment: "development",
  category: "other",
  verificationStatus: "unverified",
  minRole: "viewer",
  isPreviewSafe: true,
  exposureType: "server",
  createdAt: timestamp,
  updatedAt: timestamp,
  lastUsedAt: null,
  ...overrides,
});

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(secretsRouter);
  return app;
}

function expectWriteOnly(body: Record<string, unknown>) {
  expect(body.masked).toBe("••••••••");
  expect(body).not.toHaveProperty("value");
  expect(body).not.toHaveProperty("valueEncrypted");
  expect(JSON.stringify(body)).not.toContain("ciphertext-never-returned");
}

describe("project secret owner CRUD", () => {
  beforeEach(() => {
    state.selectResults = [];
    state.insertedSecret = null;
    state.updatedSecret = null;
    state.deletedIds = [];
  });

  it("creates an encrypted secret and returns metadata with a fixed mask", async () => {
    state.selectResults.push([], [row()]);

    const response = await request(buildApp()).post("/projects/7/secrets").send({
      name: "API_TOKEN",
      value: "plain-secret",
      environment: "development",
      isPreviewSafe: true,
    });

    expect(response.status).toBe(201);
    expect(state.insertedSecret?.valueEncrypted).toBe("encrypted:plain-secret");
    expectWriteOnly(response.body);
  });

  it("lists, updates, and deletes without returning a stored value", async () => {
    state.selectResults.push([{ ownerId: "owner-1", organizationId: null }], [row()]);
    const list = await request(buildApp()).get("/projects/7/secrets");
    expect(list.status).toBe(200);
    expectWriteOnly(list.body[0]);

    state.selectResults.push([row()], [row({ valueEncrypted: "encrypted:replacement" })]);
    const update = await request(buildApp())
      .patch("/projects/7/secrets/41")
      .send({ value: "replacement" });
    expect(update.status).toBe(200);
    expect(state.updatedSecret?.valueEncrypted).toBe("encrypted:replacement");
    expectWriteOnly(update.body);

    state.selectResults.push([row()]);
    const remove = await request(buildApp()).delete("/projects/7/secrets/41");
    expect(remove.status).toBe(200);
    expect(remove.body).toEqual({ deleted: true, id: 41 });
    expect(state.deletedIds).toEqual([41]);
  });
});
