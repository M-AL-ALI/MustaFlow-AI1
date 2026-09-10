import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { ProjectCardSnapshot, selectProjectSnapshot } from "./project-card-snapshot";

const mocks = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("@/lib/api-fetch", () => ({ authFetch: mocks.fetch }));
const snapshot = (overrides = {}) => ({
  id: 42,
  projectId: 901,
  kind: "snapshot",
  source: "observe",
  mimeType: "image/png",
  sizeBytes: 128,
  createdAt: "2026-09-08T00:00:00Z",
  context: {},
  ...overrides,
});
beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
describe("Private project-card snapshots", () => {
  it("fetches only the canonical content URL and revokes a loaded preview after identity changes", async () => {
    const create = vi.fn(() => "blob:private-preview");
    const revoke = vi.fn();
    vi.stubGlobal(
      "URL",
      class extends URL {
        static createObjectURL = create;
        static revokeObjectURL = revoke;
      },
    );
    const reader = {
      read: vi
        .fn()
        .mockResolvedValueOnce({ value: new Uint8Array([137, 80, 78, 71]), done: false })
        .mockResolvedValue({ done: true }),
      cancel: vi.fn().mockResolvedValue(undefined),
      releaseLock: vi.fn(),
    };
    mocks.fetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          assets: [snapshot({ contentUrl: "https://untrusted.invalid/image" })],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        headers: { get: (name: string) => (name === "content-type" ? "image/png" : "4") },
        body: { getReader: () => reader },
      });
    const { rerender } = render(
      <ProjectCardSnapshot projectId={901} projectName="Test" identity="owner" revision="v1" />,
    );
    const image = await screen.findByRole("img", { name: "Last saved snapshot of Test" });
    expect(image.getAttribute("src")).toBe("blob:private-preview");
    expect(mocks.fetch.mock.calls[1][0]).toBe("/api/assets/42/content");
    expect(reader.releaseLock).toHaveBeenCalledOnce();
    rerender(<ProjectCardSnapshot projectId={901} projectName="Test" revision="v1" />);
    expect(screen.queryByRole("img")).toBeNull();
    expect(revoke).toHaveBeenCalledWith("blob:private-preview");
  });
  it("rejects oversized image content without allocating a preview URL", async () => {
    const getReader = vi.fn();
    mocks.fetch
      .mockResolvedValueOnce({ ok: true, json: async () => ({ assets: [snapshot()] }) })
      .mockResolvedValueOnce({
        ok: true,
        headers: { get: (name: string) => (name === "content-type" ? "image/png" : "9000000") },
        body: { getReader },
      });
    render(
      <ProjectCardSnapshot projectId={901} projectName="Test" identity="owner" revision="v1" />,
    );
    await screen.findByText("Saved snapshot unavailable. You can still open the project.");
    expect(getReader).not.toHaveBeenCalled();
    expect(screen.queryByRole("img")).toBeNull();
  });
  it("only chooses a full-page snapshot belonging to this project, never another project or image library", () => {
    const assets = [
      snapshot({ id: 1, projectId: 902 }),
      snapshot({ id: 2, projectId: null }),
      snapshot({ id: 3, kind: "image", source: "generated" }),
      snapshot({ id: 4, context: { region: { x: 0, y: 0 } } }),
      snapshot({ id: 5, mimeType: "image/svg+xml" }),
      snapshot({ id: 6, sizeBytes: 9000000 }),
      snapshot(),
    ];
    expect(selectProjectSnapshot({ assets }, 901)).toEqual({
      id: 42,
      createdAt: "2026-09-08T00:00:00Z",
    });
    expect(selectProjectSnapshot({ assets }, 900)).toBeNull();
  });
  it("does not fetch without the current signed-in identity", () => {
    render(<ProjectCardSnapshot projectId={901} projectName="Test" revision="v1" />);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
  it("reads metadata only and never starts capture when no saved preview exists", async () => {
    mocks.fetch.mockResolvedValue({ ok: true, json: async () => ({ assets: [] }) });
    render(
      <ProjectCardSnapshot projectId={901} projectName="Test" identity="owner" revision="v1" />,
    );
    await waitFor(() => expect(screen.getByText("Preview this project")).toBeTruthy());
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    expect(mocks.fetch.mock.calls[0][0]).toBe("/api/assets?projectId=901&limit=100");
    expect(mocks.fetch.mock.calls[0][1]).not.toHaveProperty("method");
  });
  it("fails closed on denied metadata access without fetching any image", async () => {
    mocks.fetch.mockResolvedValue({ ok: false });
    render(
      <ProjectCardSnapshot projectId={901} projectName="Test" identity="owner" revision="v1" />,
    );
    await screen.findByText("Saved snapshot unavailable. You can still open the project.");
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });
  it("aborts old work when identity changes", async () => {
    mocks.fetch.mockImplementation(() => new Promise(() => {}));
    const { rerender } = render(
      <ProjectCardSnapshot projectId={901} projectName="Test" identity="first" revision="v1" />,
    );
    const first = mocks.fetch.mock.calls[0][1].signal as AbortSignal;
    rerender(
      <ProjectCardSnapshot projectId={901} projectName="Test" identity="second" revision="v1" />,
    );
    expect(first.aborted).toBe(true);
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("img")).toBeNull();
  });
});
