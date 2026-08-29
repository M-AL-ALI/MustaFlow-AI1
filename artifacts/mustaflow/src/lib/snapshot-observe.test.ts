import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { requestSnapshotObservation, type SnapshotObserveRequest } from "./snapshot-observe";

const snapshot: SnapshotObserveRequest = {
  path: "/about",
  previewSource: "server",
  viewport: { width: 1280, height: 800 },
};

describe("snapshot observation client", () => {
  it("makes one observe request with the closed path, source, and viewport payload", async () => {
    const transport = vi.fn(async () => ({
      ok: true,
      json: async () => ({ ok: true, previewClass: "db-static" }),
    }));
    const result = await requestSnapshotObservation(51, snapshot, transport);

    expect(result).toEqual({ ok: true, previewClass: "db-static" });
    expect(transport).toHaveBeenCalledTimes(1);
    expect(transport).toHaveBeenCalledWith(
      "/api/projects/51/observe/snapshot",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify(snapshot),
      }),
    );
  });

  it("shows a fixed human refusal instead of raw server detail", async () => {
    const transport = vi.fn(async () => ({
      ok: false,
      json: async () => ({
        code: "snapshot_unavailable",
        error: "ECONNREFUSED 10.0.0.1 internal_capture_timeout",
      }),
    }));
    const result = await requestSnapshotObservation(51, snapshot, transport);

    expect(result).toEqual({
      ok: false,
      message: "I couldn't capture this preview safely. Please try again.",
    });
    expect(JSON.stringify(result)).not.toContain("ECONNREFUSED");
    expect(JSON.stringify(result)).not.toContain("internal_capture_timeout");
  });

  it("forwards the selected region and privacy masks without changing the observe route", async () => {
    const pointed: SnapshotObserveRequest = {
      ...snapshot,
      region: { x: 40, y: 50, width: 300, height: 180 },
      domPath: "body>main:nth-child(1)>button:nth-child(2)",
      annotation: "this button does nothing",
      redactions: [{ x: 70, y: 80, width: 60, height: 24 }],
    };
    const transport = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        ok: true,
        previewClass: "runtime-proxy",
        asset: { assetId: "asset-1", url: "/api/assets/asset-1/content" },
      }),
    }));

    await expect(requestSnapshotObservation(51, pointed, transport)).resolves.toEqual({
      ok: true,
      previewClass: "runtime-proxy",
      asset: { assetId: "asset-1", url: "/api/assets/asset-1/content" },
    });
    expect(transport).toHaveBeenCalledWith(
      "/api/projects/51/observe/snapshot",
      expect.objectContaining({ body: JSON.stringify(pointed) }),
    );
  });

  it("keeps the preview control on the dedicated observe callback with no mutation fallback", () => {
    const previewSource = readFileSync(
      join(process.cwd(), "src/pages/projects/components/preview-tab.tsx"),
      "utf8",
    );
    const projectSource = readFileSync(join(process.cwd(), "src/pages/projects/[id].tsx"), "utf8");
    const handler = previewSource.slice(
      previewSource.indexOf("const snapshotToAi"),
      previewSource.indexOf("// Shared iframe renderer"),
    );

    expect(handler).toContain("await onSnapshotObserve");
    expect(handler).toContain("sendRegionToAi");
    expect(handler).toContain("captureRedactions");
    expect(handler).toContain('previewSource: webContainerLive ? "webcontainer" : "server"');
    expect(handler).not.toContain("onFixPrompt");
    expect(handler).not.toContain("onAutoSendPrompt");
    expect(projectSource).toContain("const handleSnapshotObserve = useCallback");
    expect(projectSource).toContain("onSnapshotObserve={handleSnapshotObserve}");
    expect(projectSource).toContain("getListMessagesQueryKey(projectId)");
  });
});
