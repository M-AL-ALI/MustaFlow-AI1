import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  updatedTables: [] as unknown[],
  project: {
    activePreviewSessionId: null as string | null,
    testContainerId: null as string | null,
    testContainerStatus: "stopped",
  },
}));

const tables = vi.hoisted(() => ({
  projects: {
    id: "projects.id",
    activePreviewSessionId: "projects.active_preview_session_id",
    testContainerId: "projects.test_container_id",
    testContainerStatus: "projects.test_container_status",
  },
  sessions: {
    projectId: "preview_sessions.project_id",
    revokedAt: "preview_sessions.revoked_at",
  },
}));

vi.mock("@workspace/db", () => ({
  db: {
    select: vi.fn(() => ({
      from: () => ({ where: async () => [state.project] }),
    })),
    update: vi.fn((table: unknown) => ({
      set: () => ({
        where: async () => {
          state.updatedTables.push(table);
          return [];
        },
      }),
    })),
  },
  projectsTable: tables.projects,
  previewSessionsTable: tables.sessions,
}));

vi.mock("../logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn() },
}));

import { revokePreviewForSecurityChange } from "../testing-invalidation";

beforeEach(() => {
  state.updatedTables = [];
  state.project = {
    activePreviewSessionId: null,
    testContainerId: null,
    testContainerStatus: "stopped",
  };
});

describe("preview-share security invalidation", () => {
  it("revokes project-scoped share grants even when there is no active editor session", async () => {
    await revokePreviewForSecurityChange(52, "testing-secret-updated");
    expect(state.updatedTables).toEqual([tables.sessions, tables.projects]);
  });
});
