import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { authFetch } from "@/lib/api-fetch";
import { SharePreviewControl, canSharePreview } from "./share-preview-control";

vi.mock("@/lib/api-fetch", () => ({ authFetch: vi.fn() }));

const ready = {
  readiness: { state: "ready" },
  presentation: { canCelebrate: true },
} as never;
const blocked = {
  readiness: { state: "blocked" },
  presentation: { canCelebrate: false },
} as never;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("SharePreviewControl", () => {
  it("offers sharing only when readiness and running-runtime truth both pass", () => {
    expect(canSharePreview({ runtimeRunning: true, readiness: ready })).toBe(true);
    expect(canSharePreview({ runtimeRunning: false, readiness: ready })).toBe(false);
    expect(canSharePreview({ runtimeRunning: true, readiness: blocked })).toBe(false);
    expect(canSharePreview({ runtimeRunning: true, readiness: null })).toBe(false);

    const { rerender } = render(
      <SharePreviewControl projectId={52} runtimeRunning={false} readiness={ready} />,
    );
    expect(screen.getByRole("button", { name: "Share preview" })).toBeDisabled();
    rerender(<SharePreviewControl projectId={52} runtimeRunning readiness={blocked} />);
    expect(screen.getByRole("button", { name: "Share preview" })).toBeDisabled();
    rerender(<SharePreviewControl projectId={52} runtimeRunning readiness={ready} />);
    expect(screen.getByRole("button", { name: "Share preview" })).toBeEnabled();
  });

  it("mints, displays expiry honestly, and copies the full invitation link", async () => {
    const launchUrl = "https://p52.preview.mustaflow.com/__preview-launch?t=" + "a".repeat(64);
    (authFetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response(
        JSON.stringify({
          previewUrl: "https://p52.preview.mustaflow.com",
          launchUrl,
          expiresAt: "2026-08-24T08:00:00.000Z",
        }),
        { status: 201, headers: { "content-type": "application/json" } },
      ),
    );
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });

    render(<SharePreviewControl projectId={52} runtimeRunning readiness={ready} />);
    fireEvent.click(screen.getByRole("button", { name: "Share preview" }));
    await waitFor(() =>
      expect(screen.getByLabelText("Shared preview link")).toHaveValue(launchUrl),
    );
    expect(screen.getByText(/Expires/)).toBeInTheDocument();
    fireEvent.click(screen.getByTitle("Copy shared preview link"));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(launchUrl));
  });

  it("shows a human message without exposing a raw server error", async () => {
    (authFetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response(JSON.stringify({ error: "SQLSTATE 23505 internal_constraint_name" }), {
        status: 500,
      }),
    );
    render(<SharePreviewControl projectId={52} runtimeRunning readiness={ready} />);
    fireEvent.click(screen.getByRole("button", { name: "Share preview" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The preview link could not be created. Please try again.",
    );
    expect(screen.getByRole("alert")).not.toHaveTextContent("SQLSTATE");
  });
});
