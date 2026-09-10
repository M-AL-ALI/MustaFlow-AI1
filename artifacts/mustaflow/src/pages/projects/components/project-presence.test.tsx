import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import {
  useMultiplayerPresence,
  type MultiplayerPresenceState,
} from "@/hooks/use-multiplayer-presence";
import { ProjectPresence } from "./project-presence";

vi.mock("@/hooks/use-multiplayer-presence", () => ({ useMultiplayerPresence: vi.fn() }));
vi.mock("@/lib/api-fetch", () => ({ authFetch: vi.fn() }));

const basePresence: MultiplayerPresenceState = {
  enabled: true,
  status: "closed",
  peers: [],
  self: null,
  message: "Unauthorized",
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(useMultiplayerPresence).mockReturnValue(basePresence);
});
afterEach(cleanup);

const renderPresence = () =>
  render(<ProjectPresence projectId={61} location="Preview" canRevokeSupport />);

describe("Scoped collaboration errors", () => {
  it("visibly prefixes a real denial without changing its raw message", () => {
    renderPresence();
    const message = screen.getByRole("status", { name: "Collaboration status" });
    expect(message).toBeVisible();
    expect(message.textContent).toBe("Collaboration: Unauthorized");
    expect(message).not.toHaveClass("hidden", "truncate");
    expect(useMultiplayerPresence).toHaveBeenCalledWith(61, true, "Preview");
  });

  it("retains the full error rather than converting it into a build failure", () => {
    const raw = "Access removed. Ask the project owner for access before reconnecting.";
    vi.mocked(useMultiplayerPresence).mockReturnValue({ ...basePresence, message: raw });
    renderPresence();
    expect(screen.getByRole("status", { name: "Collaboration status" }).textContent).toBe(
      "Collaboration: " + raw,
    );
    expect(screen.queryByText(/build failed/i)).toBeNull();
  });

  it("does not hide a denial behind a retained peer roster", () => {
    vi.mocked(useMultiplayerPresence).mockReturnValue({
      ...basePresence,
      peers: [
        {
          id: "teammate-1",
          name: "Teammate",
          imageUrl: "/avatar.png",
          kind: "teammate",
          location: "Database",
          grantId: null,
          grantExpiresAt: null,
        },
      ],
    });
    renderPresence();
    expect(screen.getByText("Collaboration: Unauthorized")).toBeVisible();
    expect(screen.getByRole("button", { name: "1 other person in this project" })).toBeVisible();
  });

  it("does not claim a live presence when disconnected without a message", () => {
    vi.mocked(useMultiplayerPresence).mockReturnValue({ ...basePresence, message: null });
    renderPresence();
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByTestId("project-presence")).toBeNull();
  });
});
