import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectCardSnapshot, selectProjectSnapshot } from "./project-card-snapshot";

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
  createObjectURL: vi.fn(),
  revokeObjectURL: vi.fn(),
}));
vi.mock("@/lib/api-fetch", () => ({ authFetch: mocks.fetch }));

const NativeURL = globalThis.URL;
const createdAt = "2026-09-08T12:00:00.000Z";

// /api/assets already filters state='ready'; state and readyAt are not response fields.
function asset(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    projectId: 7,
    scope: "project",
    kind: "snapshot",
    source: "observe",
    versionId: 11,
    mimeType: "image/png",
    sizeBytes: 4,
    createdAt,
    context: {},
    ...overrides,
  };
}

function queueImage(assets: unknown[]) {
  const read = vi
    .fn()
    .mockResolvedValueOnce({ done: false, value: new Uint8Array([137, 80, 78, 71]) })
    .mockResolvedValueOnce({ done: true });
  mocks.fetch
    .mockResolvedValueOnce({ ok: true, json: async () => ({ assets }) })
    .mockResolvedValueOnce({
      ok: true,
      headers: {
        get: (name: string) =>
          name === "content-type" ? "image/png" : name === "content-length" ? "4" : null,
      },
      body: {
        getReader: () => ({
          read,
          cancel: vi.fn().mockResolvedValue(undefined),
          releaseLock: vi.fn(),
        }),
      },
    });
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.createObjectURL.mockReturnValue("blob:project-snapshot");
  vi.stubGlobal(
    "URL",
    class extends NativeURL {
      static createObjectURL(blob: Blob) {
        return mocks.createObjectURL(blob);
      }
      static revokeObjectURL(url: string) {
        mocks.revokeObjectURL(url);
      }
    },
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("saved project snapshot selection contract", () => {
  it("prefers the exact dashboard revision over newer unrelated saved images", () => {
    const selected = selectProjectSnapshot(
      {
        assets: [
          asset({ id: 2, source: "dashboard-preview" }),
          asset({ id: 3, createdAt: "2026-09-08T13:00:00.000Z" }),
          asset({
            id: 4,
            source: "dashboard-preview",
            versionId: 12,
            createdAt: "2026-09-08T14:00:00.000Z",
          }),
        ],
      },
      7,
      11,
    );
    expect(selected).toEqual({ id: 2, createdAt, matchedVersionId: 11 });
  });

  it("does not promote an observe image even when its version matches", () => {
    expect(selectProjectSnapshot({ assets: [asset()] }, 7, 11)).toEqual({ id: 1, createdAt });
  });

  it("preserves historical fallback when an automatic image is for another version", () => {
    expect(
      selectProjectSnapshot(
        { assets: [asset({ source: "dashboard-preview", versionId: 12 })] },
        7,
        11,
      ),
    ).toEqual({ id: 1, createdAt });
  });

  it.each([undefined, null, 0, -1, NaN, Infinity, 11.5])(
    "requires a positive immutable version ID, received %s",
    (versionId) => {
      expect(
        selectProjectSnapshot({ assets: [asset({ source: "dashboard-preview" })] }, 7, versionId),
      ).toEqual({ id: 1, createdAt });
    },
  );

  it("does not coerce string version metadata into a match", () => {
    expect(
      selectProjectSnapshot(
        { assets: [asset({ source: "dashboard-preview", versionId: "11" })] },
        7,
        11,
      ),
    ).toEqual({ id: 1, createdAt });
    expect(
      selectProjectSnapshot(
        { assets: [asset({ source: "dashboard-preview" })] },
        7,
        "11" as unknown as number,
      ),
    ).toEqual({ id: 1, createdAt });
  });

  it.each([
    { projectId: 8 },
    { source: "upload" },
    { kind: "image" },
    { context: { region: { x: 0, y: 0, width: 100, height: 100 } } },
    { context: { annotation: "selection" } },
    { mimeType: "image/svg+xml" },
    { sizeBytes: 0 },
    { sizeBytes: 8 * 1024 * 1024 + 1 },
    { sizeBytes: 1.5 },
    { id: 0 },
    { id: "1" },
    { createdAt: "invalid" },
  ])("rejects ineligible image metadata: %j", (overrides) => {
    expect(selectProjectSnapshot({ assets: [asset(overrides)] }, 7, 11)).toBeNull();
  });

  it("rejects partial dashboard captures as well as partial observations", () => {
    expect(
      selectProjectSnapshot(
        {
          assets: [
            asset({
              source: "dashboard-preview",
              context: { region: null },
            }),
          ],
        },
        7,
        11,
      ),
    ).toBeNull();
  });

  it.each([null, undefined, {}, { assets: null }, { assets: [] }])(
    "preserves the empty fallback: %j",
    (value) => {
      expect(selectProjectSnapshot(value, 7, 11)).toBeNull();
    },
  );

  it("chooses the newest historical image without mutating the response array", () => {
    const rows = Object.freeze([
      asset({ id: 1 }),
      asset({ id: 2, createdAt: "2026-09-08T13:00:00.000Z" }),
    ]);
    expect(selectProjectSnapshot({ assets: rows }, 7)).toEqual({
      id: 2,
      createdAt: "2026-09-08T13:00:00.000Z",
    });
    expect(rows[0].id).toBe(1);
  });
});

describe("saved project snapshot presentation", () => {
  it("labels the existing timestamp-only caller as historical, never current or automatic", async () => {
    queueImage([asset({ source: "dashboard-preview" })]);
    render(
      <ProjectCardSnapshot projectId={7} projectName="Example" identity="owner" revision="11" />,
    );
    expect(await screen.findByAltText("Last saved snapshot of Example")).toBeTruthy();
    expect(screen.getByText("May not match the current project version.")).toBeTruthy();
    expect(screen.queryByText(/current automatic preview/i)).toBeNull();
  });

  it("labels observe images as historical despite a supplied matching version", async () => {
    queueImage([asset()]);
    render(
      <ProjectCardSnapshot
        projectId={7}
        projectName="Example"
        identity="owner"
        revision={createdAt}
        requestedVersionId={11}
      />,
    );
    expect(await screen.findByAltText("Last saved snapshot of Example")).toBeTruthy();
    expect(screen.queryByText("Saved for the requested version; not a live view.")).toBeNull();
  });

  it("uses the canonical private asset URL and describes only the matched saved version", async () => {
    queueImage([
      asset({
        id: 2,
        source: "dashboard-preview",
        contentUrl: "https://untrusted.invalid/image.png",
      }),
    ]);
    const view = render(
      <ProjectCardSnapshot
        projectId={7}
        projectName="Example"
        identity="owner"
        revision={createdAt}
        requestedVersionId={11}
      />,
    );
    expect(await screen.findByAltText("Saved snapshot of Example at version 11")).toBeTruthy();
    expect(screen.getByText("Saved for the requested version; not a live view.")).toBeTruthy();
    expect(mocks.fetch.mock.calls.map(([url]) => url)).toEqual([
      "/api/assets?projectId=7&limit=100",
      "/api/assets/2/content",
    ]);
    expect(mocks.fetch.mock.calls.every(([, options]) => options.method === undefined)).toBe(true);
    view.unmount();
    expect(mocks.revokeObjectURL).toHaveBeenCalledWith("blob:project-snapshot");
  });

  it("invalidates the selected version independently of the dashboard timestamp", async () => {
    queueImage([asset({ source: "dashboard-preview" })]);
    const view = render(
      <ProjectCardSnapshot
        projectId={7}
        projectName="Example"
        identity="owner"
        revision={createdAt}
        requestedVersionId={11}
      />,
    );
    await screen.findByAltText("Saved snapshot of Example at version 11");
    mocks.fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ assets: [] }) });
    view.rerender(
      <ProjectCardSnapshot
        projectId={7}
        projectName="Example"
        identity="owner"
        revision={createdAt}
        requestedVersionId={12}
      />,
    );
    await waitFor(() => expect(mocks.fetch).toHaveBeenCalledTimes(3));
    expect(screen.queryByAltText("Saved snapshot of Example at version 11")).toBeNull();
    expect(await screen.findByText("Preview this project")).toBeTruthy();
  });

  it("does not request image bytes or trigger capture when the ready-asset list is empty", async () => {
    mocks.fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ assets: [] }) });
    render(
      <ProjectCardSnapshot
        projectId={7}
        projectName="Example"
        identity="owner"
        revision={createdAt}
      />,
    );
    expect(await screen.findByText("Preview this project")).toBeTruthy();
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    expect(mocks.createObjectURL).not.toHaveBeenCalled();
  });
});
