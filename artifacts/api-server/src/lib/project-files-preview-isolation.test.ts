import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  rows: [] as { path: string; mimeType: string; content: string }[],
}));
vi.mock("@workspace/db", () => ({
  projectFilesTable: { projectId: "projectId", path: "path" },
  db: { select: () => ({ from: () => ({ where: async () => state.rows }) }) },
}));
vi.mock("drizzle-orm", () => ({
  and: vi.fn(),
  asc: vi.fn(),
  eq: vi.fn(),
  or: vi.fn(),
  like: vi.fn(),
}));
vi.mock("./builder", () => ({ guessMime: () => "text/html" }));
vi.mock("./binary-mime", () => ({ isBinaryMime: () => false }));
vi.mock("./project-file-asset-reference", () => ({ resolveProjectFileBytes: vi.fn() }));
vi.mock("./consoleBridge", () => ({ injectBridge: (html: string) => html, MOCK_FLAG_SCRIPT: "" }));
vi.mock("./visualEditScript", () => ({ VISUAL_EDIT_SCRIPT: "" }));

import { serveProjectFilesPreview } from "./project-files-preview";

function appFor(editor: boolean) {
  const app = express();
  app.get("/preview", async (_req, res) => {
    await serveProjectFilesPreview(res, 71, "index.html", { visualEditEnabled: editor });
  });
  return app;
}

beforeEach(() => {
  state.rows = [
    {
      path: "index.html",
      mimeType: "text/html",
      content: "<!doctype html><script>window.tenant = true</script>",
    },
  ];
});

describe("database-backed editor preview isolation", () => {
  it("enforces a response sandbox when runtime state falls back to stored tenant HTML", async () => {
    const response = await request(appFor(true)).get("/preview").expect(200);
    expect(response.headers["content-security-policy"]).toBe(
      "sandbox allow-scripts allow-forms allow-popups",
    );
    expect(response.text).toContain("window.tenant = true");
  });
  it("also applies the policy to empty-project documents", async () => {
    state.rows = [];
    const response = await request(appFor(true)).get("/preview").expect(404);
    expect(response.headers["content-security-policy"]).toContain("sandbox allow-scripts");
  });
  it("does not silently sandbox the separate non-editor public-app serving contract", async () => {
    const response = await request(appFor(false)).get("/preview").expect(200);
    expect(response.headers["content-security-policy"]).toBeUndefined();
  });
});
