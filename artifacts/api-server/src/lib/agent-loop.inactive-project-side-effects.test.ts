import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  process.env.DATABASE_URL = "postgresql://test:test@127.0.0.1:1/test";
  return {
    selectResults: [] as unknown[][],
    select: vi.fn(),
    withActiveProjectLifecycle: vi.fn(),
    materializeProjectAsset: vi.fn(),
    takeScreenshot: vi.fn(),
    reserveAsset: vi.fn(),
    reserveAssetAgainstAvailableQuota: vi.fn(),
    beginAssetUpload: vi.fn(),
    putAssetBuffer: vi.fn(),
    completeAsset: vi.fn(),
    generateImageAsset: vi.fn(),
    generateVideoAsset: vi.fn(),
    generateAudioAsset: vi.fn(),
    removeImageBackgroundAsset: vi.fn(),
  };
});

function selectQuery(rows: unknown[]) {
  const query = {
    from: vi.fn(),
    where: vi.fn(),
    orderBy: vi.fn(),
    limit: vi.fn(async () => rows),
    then: <TResult1 = unknown[], TResult2 = never>(
      onfulfilled?: ((value: unknown[]) => TResult1 | PromiseLike<TResult1>) | null,
      onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
    ) => Promise.resolve(rows).then(onfulfilled, onrejected),
  };
  query.from.mockReturnValue(query);
  query.where.mockReturnValue(query);
  query.orderBy.mockReturnValue(query);
  return query;
}

vi.mock("@workspace/integrations-openai-ai-server", () => ({ openai: {} }));

vi.mock("@workspace/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@workspace/db")>();
  mocks.select.mockImplementation(() => selectQuery(mocks.selectResults.shift() ?? []));
  return {
    ...actual,
    db: { ...actual.db, select: mocks.select },
  };
});

vi.mock("./project-lifecycle", () => ({
  withActiveProjectLifecycle: mocks.withActiveProjectLifecycle,
}));

vi.mock("../routes/assets", () => ({
  materializeProjectAsset: mocks.materializeProjectAsset,
}));

vi.mock("./agent-senses", () => ({
  takeScreenshot: mocks.takeScreenshot,
}));

vi.mock("./asset-registry", () => ({
  reserveAsset: mocks.reserveAsset,
  reserveAssetAgainstAvailableQuota: mocks.reserveAssetAgainstAvailableQuota,
  beginAssetUpload: mocks.beginAssetUpload,
  cancelReservedAsset: vi.fn(),
  completeAsset: mocks.completeAsset,
  rejectReservedAsset: vi.fn(),
}));

vi.mock("./asset-r2", () => ({
  assetR2Configured: vi.fn(() => true),
  putAssetBuffer: mocks.putAssetBuffer,
  deleteAssetObject: vi.fn(),
  readAssetBuffer: vi.fn(),
}));

vi.mock("./agent-creative", () => ({
  generateImageAsset: mocks.generateImageAsset,
  generateVideoAsset: mocks.generateVideoAsset,
  generateAudioAsset: mocks.generateAudioAsset,
  removeImageBackgroundAsset: mocks.removeImageBackgroundAsset,
}));

import { executeTool, FileWorkspace, type ToolCtx } from "./agent-loop";

function makeToolCtx(name: string, args: Record<string, unknown>): ToolCtx {
  return {
    name,
    args,
    workspace: new FileWorkspace([]),
    stack: "react-vite",
    profile: { checks: [], installCmd: null },
    input: {
      mode: "build",
      projectId: 51,
      projectName: "Inactive lifecycle test",
      projectKind: "web",
      projectFormat: "react-vite",
      stack: "react-vite",
      userPrompt: "Exercise the inactive lifecycle boundary.",
      agentMode: "lite",
      existingFiles: [],
      ownerUserId: "owner-51",
      actorUserId: "owner-51",
      previewUrl: "https://preview.example.test",
      onEvent: vi.fn(),
      onFileMutation: vi.fn(),
      signal: new AbortController().signal,
    },
    commandsRun: [],
    step: 1,
    containerState: { id: null, installed: false },
    loadedSkills: new Map(),
    e2eResults: [],
    screenshotBudget: { remaining: 5 * 1024 * 1024 },
    fetchBudget: { remaining: 20 },
    senseCounts: {
      screenshot: 0,
      webFetch: 0,
      webSearch: 0,
      branding: 0,
      diagnostics: 0,
    },
    creativeBudget: { remaining: 5 },
    creativeCounts: { image: 0, video: 0, audio: 0, bgRemoval: 0 },
    presentedAssets: [],
    loopStartedAt: Date.now(),
    loopWallClockMs: 60_000,
  };
}

function expectNoAssetOrProviderSideEffects() {
  expect(mocks.materializeProjectAsset).not.toHaveBeenCalled();
  expect(mocks.reserveAsset).not.toHaveBeenCalled();
  expect(mocks.reserveAssetAgainstAvailableQuota).not.toHaveBeenCalled();
  expect(mocks.beginAssetUpload).not.toHaveBeenCalled();
  expect(mocks.putAssetBuffer).not.toHaveBeenCalled();
  expect(mocks.completeAsset).not.toHaveBeenCalled();
  expect(mocks.generateImageAsset).not.toHaveBeenCalled();
  expect(mocks.generateVideoAsset).not.toHaveBeenCalled();
  expect(mocks.generateAudioAsset).not.toHaveBeenCalled();
  expect(mocks.removeImageBackgroundAsset).not.toHaveBeenCalled();
}

describe("Zero tools reject inactive projects before side effects", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.selectResults = [];
    mocks.withActiveProjectLifecycle.mockResolvedValue({ state: "inactive" });
    mocks.takeScreenshot.mockResolvedValue({
      ok: true,
      base64: Buffer.from("screenshot").toString("base64"),
      bytes: Buffer.byteLength("screenshot"),
      width: 1280,
      height: 800,
      finalUrl: "https://preview.example.test",
      consoleErrors: [],
    });
  });

  it("does not materialize an upload after lifecycle admission rejects the project", async () => {
    // place_upload performs its owner lookup before entering the mutation lifecycle.
    mocks.selectResults = [[{ ownerUserId: "owner-51" }]];

    const result = await executeTool(makeToolCtx("place_upload", { id: 91 }));

    expect(result).toEqual({ ok: false, observation: "ERROR: project is unavailable" });
    expect(mocks.withActiveProjectLifecycle).toHaveBeenCalledWith(51, expect.any(Function));
    expectNoAssetOrProviderSideEffects();
  });

  it("does not capture or persist a screenshot for an inactive project", async () => {
    // These rows keep the test capable of reaching a late lifecycle check; a correct
    // implementation rejects before consuming them or invoking the screenshot provider.
    mocks.selectResults = [[{ ownerId: "owner-51" }], []];

    const result = await executeTool(
      makeToolCtx("take_screenshot", {
        url: "https://preview.example.test",
        evidence_phase: "evidence",
      }),
    );

    expect(result).toEqual({
      ok: false,
      observation: "ERROR: visual_evidence_project_unavailable",
    });
    expect(mocks.withActiveProjectLifecycle).toHaveBeenCalledWith(51, expect.any(Function));
    expect(mocks.takeScreenshot).not.toHaveBeenCalled();
    expectNoAssetOrProviderSideEffects();
  });

  it.each([
    ["generate_image", { path: "hero.png", prompt: "A quiet product hero" }],
    ["generate_video", { path: "hero.mp4", prompt: "A quiet product hero" }],
    ["generate_audio", { path: "intro.mp3", text: "Welcome" }],
    ["remove_image_background", { path: "source.png" }],
  ])("does not reserve, call a provider, or persist output for inactive %s", async (name, args) => {
    const result = await executeTool(makeToolCtx(name, args));

    expect(result).toEqual({ ok: false, observation: "ERROR: project is unavailable" });
    expect(mocks.withActiveProjectLifecycle).toHaveBeenCalledWith(51, expect.any(Function));
    expect(mocks.takeScreenshot).not.toHaveBeenCalled();
    expectNoAssetOrProviderSideEffects();
  });
});
