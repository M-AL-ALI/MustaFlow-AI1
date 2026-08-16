import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BuilderChunkRecoveryError,
  BuilderChunkReloadPendingError,
  persistBuilderChunkFailure,
} from "@/lib/builder-chunk-recovery";
import { BuilderChunkErrorBoundary } from "./builder-chunk-error-boundary";

function ThrowError({ error }: { error: Error }): never {
  throw error;
}

describe("BuilderChunkErrorBoundary", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders the calm refreshing state while the guarded reload is pending", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    render(
      <BuilderChunkErrorBoundary pathname="/projects/44">
        <ThrowError error={new BuilderChunkReloadPendingError()} />
      </BuilderChunkErrorBoundary>,
    );

    expect(screen.getByRole("status")).toHaveTextContent("NabuFlow was updated — refreshing…");
    expect(screen.queryByTestId("builder-chunk-fallback")).not.toBeInTheDocument();
  });

  it("renders a usable final fallback and clears the guard before manual reload", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const reload = vi.fn();
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      removeItem: vi.fn((key: string) => values.delete(key)),
      setItem: (key: string, value: string) => values.set(key, value),
    };
    persistBuilderChunkFailure(storage, {
      pathname: "/projects/44",
      stage: "retry",
      error: new TypeError(
        "Failed to fetch dynamically imported module: https://www.mustaflow.com/assets/_id_-C9c46yz6.js",
      ),
      assetProbe: { outcome: "response", status: 503, mediaType: "other" },
      origin: "https://www.mustaflow.com",
      now: () => 0,
    });

    render(
      <BuilderChunkErrorBoundary pathname="/projects/44" storage={storage} reload={reload}>
        <ThrowError error={new BuilderChunkRecoveryError()} />
      </BuilderChunkErrorBoundary>,
    );

    expect(screen.getByTestId("builder-chunk-fallback")).toHaveTextContent(
      "NabuFlow couldn’t finish loading this workspace.",
    );
    expect(screen.getByTestId("builder-chunk-diagnostic")).toHaveTextContent("TypeError");
    expect(screen.getByTestId("builder-chunk-diagnostic")).toHaveTextContent(
      "/assets/_id_-C9c46yz6.js",
    );
    expect(screen.getByTestId("builder-chunk-diagnostic")).toHaveTextContent("HTTP 503 other");
    expect(screen.getByTestId("builder-chunk-diagnostic")).not.toHaveTextContent("stack");
    fireEvent.click(screen.getByRole("button", { name: "Reload" }));

    expect(storage.removeItem).toHaveBeenCalledWith(
      "mustaflow:builder-chunk-recovery:v2:/projects/44",
    );
    expect(storage.removeItem).toHaveBeenCalledTimes(1);
    expect(values.has("mustaflow:builder-chunk-failure:v1:project-workspace")).toBe(true);
    expect(reload).toHaveBeenCalledOnce();
  });
});
