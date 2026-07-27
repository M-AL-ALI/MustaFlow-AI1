import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  let serverReady: ((port: number, url: string) => void) | null = null;
  const pipeTo = vi.fn(() => Promise.resolve());
  const kill = vi.fn();
  const mount = vi.fn(() => Promise.resolve());
  const spawn = vi.fn(async (_command: string, args: string[]) => {
    const process = {
      output: { pipeTo },
      exit: Promise.resolve(0),
      kill,
    };
    if (args[0] === "run" && args[1] === "dev") {
      queueMicrotask(() => serverReady?.(5173, "https://5173.webcontainer.test"));
    }
    return process;
  });
  const on = vi.fn(
    (_event: string, callback: (port: number, url: string) => void): (() => void) => {
      serverReady = callback;
      return vi.fn();
    },
  );
  const boot = vi.fn(() => Promise.resolve({ mount, spawn, on }));
  const getFiles = vi.fn();

  return {
    boot,
    getFiles,
    kill,
    mount,
    on,
    pipeTo,
    resetServerReady: () => {
      serverReady = null;
    },
    spawn,
  };
});

vi.mock("@webcontainer/api", () => ({
  WebContainer: { boot: mocks.boot },
}));

vi.mock("@workspace/api-client-react", () => ({
  getProjectAllFileContent: mocks.getFiles,
}));

import { useWebContainer } from "../use-web-container";

describe("useWebContainer isolation support", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resetServerReady();
    Object.defineProperty(window, "crossOriginIsolated", {
      configurable: true,
      value: true,
    });
    mocks.getFiles.mockResolvedValue([
      {
        path: "package.json",
        content: JSON.stringify({
          scripts: { dev: "vite --host 0.0.0.0" },
          dependencies: { "@vitejs/plugin-react": "latest", vite: "latest", react: "latest" },
        }),
      },
      { path: "index.html", content: '<div id="root"></div>' },
      { path: "src/main.tsx", content: 'document.querySelector("#root")!.textContent = "Hello";' },
    ]);
  });

  afterEach(() => {
    Object.defineProperty(window, "crossOriginIsolated", {
      configurable: true,
      value: false,
    });
  });

  it("boots, mounts, installs, and exposes the react-vite preview URL when isolated", async () => {
    const { result, unmount } = renderHook(() =>
      useWebContainer({ projectId: 5001, enabled: true }),
    );

    await waitFor(() => expect(result.current.status).toBe("ready"));

    expect(mocks.boot).toHaveBeenCalledOnce();
    expect(mocks.mount).toHaveBeenCalledOnce();
    expect(mocks.spawn).toHaveBeenNthCalledWith(1, "npm", ["install"]);
    expect(mocks.spawn).toHaveBeenNthCalledWith(2, "npm", ["run", "dev"]);
    expect(result.current.previewUrl).toBe("https://5173.webcontainer.test");

    unmount();
    expect(mocks.kill).toHaveBeenCalled();
  });
});
