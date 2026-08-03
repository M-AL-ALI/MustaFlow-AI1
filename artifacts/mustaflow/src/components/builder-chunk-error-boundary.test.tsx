import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BuilderChunkRecoveryError,
  BuilderChunkReloadPendingError,
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
    const removeItem = vi.fn();

    render(
      <BuilderChunkErrorBoundary pathname="/projects/44" storage={{ removeItem }} reload={reload}>
        <ThrowError error={new BuilderChunkRecoveryError()} />
      </BuilderChunkErrorBoundary>,
    );

    expect(screen.getByTestId("builder-chunk-fallback")).toHaveTextContent(
      "NabuFlow couldn’t finish loading this workspace.",
    );
    fireEvent.click(screen.getByRole("button", { name: "Reload" }));

    expect(removeItem).toHaveBeenCalledOnce();
    expect(reload).toHaveBeenCalledOnce();
  });
});
