import { describe, expect, it } from "vitest";
import {
  getPreviewAddress,
  getPreviewIframeSandbox,
  getPreviewRecoveryControl,
  getServerPreviewBadge,
  hasServerPreviewAccess,
  presentAgenticPreviewUnavailable,
} from "./preview-access-ui";

describe("preview access UI", () => {
  it("treats direct and gateway transports as reachable without consulting a URL", () => {
    expect(hasServerPreviewAccess("direct")).toBe(true);
    expect(hasServerPreviewAccess("gateway")).toBe(true);
    expect(hasServerPreviewAccess("unavailable")).toBe(false);
    expect(hasServerPreviewAccess(undefined)).toBe(false);
  });

  it("lets isolated server previews retain their signed browser session", () => {
    expect(getPreviewIframeSandbox({ serverPreviewLive: true, webContainerLive: false })).toContain(
      "allow-same-origin",
    );
    expect(getPreviewIframeSandbox({ serverPreviewLive: false, webContainerLive: true })).toContain(
      "allow-same-origin",
    );
  });

  it("keeps same-origin database previews opaque to protect the editor", () => {
    expect(getPreviewIframeSandbox({ serverPreviewLive: false, webContainerLive: false })).toBe(
      "allow-scripts allow-forms allow-popups",
    );
  });

  it("presents the active provider transport honestly", () => {
    expect(getServerPreviewBadge("direct")?.label).toBe("Full App Preview — Container");
    expect(getServerPreviewBadge("gateway")?.label).toBe("Full App Preview — Gateway");
    expect(getServerPreviewBadge("unavailable")).toBeNull();
  });

  it("uses a direct endpoint only for direct transport", () => {
    expect(
      getPreviewAddress({
        previewAccess: "direct",
        containerUrl: "https://direct.example.test",
        webContainerUrl: null,
        projectId: 52,
      }),
    ).toBe("https://direct.example.test");
    expect(
      getPreviewAddress({
        previewAccess: "gateway",
        containerUrl: "https://stale-direct.example.test",
        webContainerUrl: null,
        projectId: 52,
      }),
    ).toBe("preview/52/");
  });

  it("falls back to the browser runtime only when server preview is unavailable", () => {
    expect(
      getPreviewAddress({
        previewAccess: "unavailable",
        containerUrl: null,
        webContainerUrl: "https://webcontainer.example.test",
        projectId: 52,
      }),
    ).toBe("https://webcontainer.example.test");
  });

  it("offers only actions that match observed preview truth", () => {
    expect(presentAgenticPreviewUnavailable("stopped")).toMatchObject({
      title: "Your preview is offline",
      action: "wake",
      actionLabel: "Wake preview",
    });
    expect(presentAgenticPreviewUnavailable("hibernated").action).toBe("wake");
    expect(presentAgenticPreviewUnavailable("error")).toMatchObject({
      title: "We could not check your preview",
      action: "retry",
    });
    expect(presentAgenticPreviewUnavailable("starting")).toMatchObject({
      title: "Waking your preview…",
      action: null,
    });
  });

  it("never exposes the provider's raw unavailable terminal in user copy", () => {
    for (const status of ["stopped", "starting", "running", "hibernated", "error"] as const) {
      const presentation = presentAgenticPreviewUnavailable(status);
      const visible = [
        presentation.title,
        presentation.message,
        presentation.actionLabel ?? "",
      ].join(" ");
      expect(visible).not.toContain("preview_runtime_unavailable");
      expect(visible).not.toContain("runtime is not running");
    }
  });

  it("keeps explicit recovery reachable when a stale provider label says running", () => {
    expect(getPreviewRecoveryControl({ hasRuntime: false, status: "running" })).toBeNull();
    expect(getPreviewRecoveryControl({ hasRuntime: true, status: "running" })).toEqual({
      label: "Restart preview",
      disabled: false,
    });
    expect(getPreviewRecoveryControl({ hasRuntime: true, status: "stopped" })).toEqual({
      label: "Wake preview",
      disabled: false,
    });
    expect(getPreviewRecoveryControl({ hasRuntime: true, status: "hibernated" })).toEqual({
      label: "Wake preview",
      disabled: false,
    });
    expect(getPreviewRecoveryControl({ hasRuntime: true, status: "error" })).toEqual({
      label: "Wake preview",
      disabled: false,
    });
    expect(getPreviewRecoveryControl({ hasRuntime: true, status: "starting" })).toEqual({
      label: "Waking preview…",
      disabled: true,
    });
  });
});
