import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

interface TestFile {
  projectId: number;
  path: string;
  content: string;
  mimeType?: string | null;
}

interface TestVersion {
  id: number;
  projectId: number;
  label: string;
  note?: string | null;
  changelogEntry?: string | null;
  filesSnapshot: Array<{ path: string; content: string; mimeType?: string | null }>;
  planSnapshot?: Record<string, unknown> | null;
  validationStatus?: string | null;
}

const testState = vi.hoisted(() => ({
  versions: [] as TestVersion[],
  files: [] as TestFile[],
  messages: [] as Array<Record<string, unknown>>,
  nextVersionId: 100,
  captures: vi.fn(),
  previewEvents: vi.fn(),
}));

const tables = vi.hoisted(() => ({
  projects: {
    id: "projects.id",
    containerId: "projects.container_id",
    containerStatus: "projects.container_status",
  },
  versions: {
    id: "project_versions.id",
    projectId: "project_versions.project_id",
  },
  files: {
    projectId: "project_files.project_id",
    path: "project_files.path",
    content: "project_files.content",
    mimeType: "project_files.mime_type",
  },
  messages: {
    id: "chat_messages.id",
    projectId: "chat_messages.project_id",
    checkpointId: "chat_messages.checkpoint_id",
    createdAt: "chat_messages.created_at",
  },
  snapshots: {
    projectId: "db_snapshots.project_id",
    versionId: "db_snapshots.version_id",
    createdAt: "db_snapshots.created_at",
  },
  secrets: {
    projectId: "secrets.project_id",
    name: "secrets.name",
  },
}));

vi.mock("@workspace/db", () => {
  function insertInto(table: unknown, value: unknown) {
    const values = Array.isArray(value) ? value : [value];
    let inserted: Array<Record<string, unknown>> = [];

    if (table === tables.versions) {
      inserted = values.map((entry) => {
        const row = {
          ...(entry as Record<string, unknown>),
          id: testState.nextVersionId++,
        } as unknown as TestVersion;
        testState.versions.push(row);
        return row as unknown as Record<string, unknown>;
      });
    } else if (table === tables.files) {
      testState.files.push(...(values as TestFile[]));
      inserted = values as Array<Record<string, unknown>>;
    } else if (table === tables.messages) {
      testState.messages.push(...(values as Array<Record<string, unknown>>));
      inserted = values as Array<Record<string, unknown>>;
    }

    const result = Promise.resolve(inserted) as Promise<Array<Record<string, unknown>>> & {
      returning: () => Promise<Array<Record<string, unknown>>>;
    };
    result.returning = async () => inserted;
    return result;
  }

  const fakeDb = {
    select: vi.fn(() => ({
      from: (table: unknown) => ({
        where: () => {
          if (table === tables.versions) return Promise.resolve([testState.versions[0]]);
          if (table === tables.files) {
            return Promise.resolve(
              testState.files.map(({ path, content, mimeType }) => ({
                path,
                content,
                mimeType,
              })),
            );
          }
          if (table === tables.snapshots) {
            return {
              orderBy: () => ({
                limit: async () => [],
              }),
            };
          }
          return Promise.resolve([]);
        },
      }),
    })),
    insert: vi.fn((table: unknown) => ({
      values: (value: unknown) => insertInto(table, value),
    })),
    delete: vi.fn((table: unknown) => ({
      where: async () => {
        if (table === tables.files) testState.files = [];
        return [];
      },
    })),
    update: vi.fn(() => ({
      set: () => ({
        where: async () => [],
      }),
    })),
    transaction: vi.fn(async (callback: (tx: unknown) => Promise<void>) => callback(fakeDb)),
  };

  return {
    db: fakeDb,
    projectsTable: tables.projects,
    projectVersionsTable: tables.versions,
    projectFilesTable: tables.files,
    chatMessagesTable: tables.messages,
    dbSnapshotsTable: tables.snapshots,
    secretsTable: tables.secrets,
  };
});

vi.mock("../../lib/auth", () => ({
  requireProjectOwnership: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

vi.mock("../../lib/db-snapshot-capture", () => ({
  captureProjectDbSnapshot: testState.captures,
}));

vi.mock("../../lib/preview-events", () => ({
  publishProjectFilesChanged: testState.previewEvents,
}));

vi.mock("../../lib/project-search", () => ({
  invalidateProjectEmbeddings: vi.fn(),
}));

vi.mock("../../lib/encryption", () => ({
  encryptionService: { decrypt: vi.fn() },
}));

vi.mock("../../lib/db-snapshot-restore", () => ({
  restorePostgresDump: vi.fn(),
  restoreSQLiteSnapshot: vi.fn(),
}));

vi.mock("../../lib/snapshot-storage", () => ({
  downloadSnapshotBlob: vi.fn(),
}));

vi.mock("../../lib/logger", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import checkpointsRouter from "../checkpoints";

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.userId = "test-user";
    req.log = {
      error: vi.fn(),
      warn: vi.fn(),
      info: vi.fn(),
      debug: vi.fn(),
    } as never;
    next();
  });
  app.use(checkpointsRouter);
  return app;
}

describe("Version History restore", () => {
  beforeEach(() => {
    testState.versions = [
      {
        id: 7,
        projectId: 45,
        label: "Before subtitle change",
        filesSnapshot: [
          {
            path: "src/App.tsx",
            content: "export const subtitle = 'Earlier';",
            mimeType: "text/typescript",
          },
        ],
        planSnapshot: { title: "Earlier plan" },
        validationStatus: "passed",
      },
      {
        id: 8,
        projectId: 45,
        label: "Current build",
        filesSnapshot: [],
      },
    ];
    testState.files = [
      {
        projectId: 45,
        path: "src/App.tsx",
        content: "export const subtitle = 'Current';",
        mimeType: "text/typescript",
      },
      {
        projectId: 45,
        path: "src/New.ts",
        content: "export const newFile = true;",
        mimeType: "text/typescript",
      },
    ];
    testState.messages = [
      { id: 1, projectId: 45, role: "user", content: "Build the app" },
      { id: 2, projectId: 45, role: "assistant", content: "Done" },
    ];
    testState.nextVersionId = 100;
    testState.captures.mockReset().mockResolvedValue(null);
    testState.previewEvents.mockReset();
  });

  it("round-trips files while appending safety and restored checkpoints without deleting history", async () => {
    const originalVersionIds = testState.versions.map((version) => version.id);
    const originalMessages = testState.messages.map((message) => ({ ...message }));

    const response = await request(buildApp()).post("/projects/45/checkpoints/7/restore");

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      checkpointId: 7,
      forwardCheckpointId: 100,
      restoredCheckpointId: 101,
      restoredFiles: 1,
      truncatedMessages: 0,
    });

    expect(testState.versions.map((version) => version.id)).toEqual([
      ...originalVersionIds,
      100,
      101,
    ]);
    expect(testState.versions[2].filesSnapshot).toEqual([
      {
        path: "src/App.tsx",
        content: "export const subtitle = 'Current';",
        mimeType: "text/typescript",
      },
      {
        path: "src/New.ts",
        content: "export const newFile = true;",
        mimeType: "text/typescript",
      },
    ]);
    expect(testState.versions[3]).toMatchObject({
      label: 'Restored "Before subtitle change"',
      filesSnapshot: testState.versions[0].filesSnapshot,
      planSnapshot: { title: "Earlier plan" },
      validationStatus: "passed",
    });
    expect(testState.files).toEqual([
      {
        projectId: 45,
        path: "src/App.tsx",
        content: "export const subtitle = 'Earlier';",
        mimeType: "text/typescript",
      },
    ]);
    expect(testState.messages.slice(0, 2)).toEqual(originalMessages);
    expect(testState.messages).toHaveLength(3);
    expect(testState.previewEvents).toHaveBeenCalledWith(
      45,
      101,
      [{ path: "src/App.tsx", content: "export const subtitle = 'Earlier';" }],
      ["src/New.ts"],
      "rollback",
    );
    expect(testState.captures).toHaveBeenNthCalledWith(1, 45, 100, "Before version restore");
    expect(testState.captures).toHaveBeenNthCalledWith(
      2,
      45,
      101,
      'Restored "Before subtitle change"',
    );
  });
});
