import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { authFetch } from "@/lib/api-fetch";
import { ArtifactTabs } from "./artifact-tabs";
import { EditorToolStrip } from "./editor-tool-strip";

vi.mock("@/lib/api-fetch", () => ({ authFetch: vi.fn() }));

const primaryArtifact = {
  id: 7,
  projectId: 61,
  kind: "web",
  name: "Notebook",
  isPrimary: true,
};

beforeEach(() => {
  vi.mocked(authFetch).mockReset();
  vi.mocked(authFetch).mockResolvedValue({
    ok: true,
    json: async () => [primaryArtifact],
  } as Response);
});

describe("artifact creation and project tool navigation", () => {
  it("keeps single-artifact creation in normal flow, including phone-sized layouts", async () => {
    render(<ArtifactTabs projectId={61} activeArtifactId={7} onSelect={vi.fn()} />);

    const controls = await screen.findByRole("group", { name: "Project components" });
    const add = within(controls).getByRole("button", { name: "Add artifact" });
    for (const element of [controls, add]) {
      expect(element.className).not.toMatch(/\b(?:absolute|fixed|hidden|top-14|right-3|z-10)\b/);
    }
    expect(add).toHaveAttribute("type", "button");
    expect(add).toHaveClass("min-h-11");
  });

  it("opens the tool catalog independently without opening artifact creation or writing data", async () => {
    const user = userEvent.setup();
    const onOpenTools = vi.fn();
    render(
      <>
        <ArtifactTabs projectId={61} activeArtifactId={7} onSelect={vi.fn()} />
        <EditorToolStrip
          projectId={61}
          activeTab="preview"
          isPublished={false}
          isMobile={false}
          chatOpen={false}
          pageMapSyncing={false}
          onNavigate={vi.fn()}
          onOpenTools={onOpenTools}
          onToggleChat={vi.fn()}
        />
      </>,
    );
    await screen.findByRole("group", { name: "Project components" });
    await user.click(screen.getByRole("button", { name: "Open project tools" }));

    expect(onOpenTools).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog", { name: "Add an artifact" })).not.toBeInTheDocument();
    expect(authFetch).toHaveBeenCalledTimes(1);
    expect(authFetch).toHaveBeenCalledWith("/api/projects/61/artifacts", {
      credentials: "include",
    });
  });

  it("opens and cancels artifact creation without submitting a surrounding form or creating data", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn((event: React.FormEvent) => event.preventDefault());
    render(
      <form onSubmit={onSubmit}>
        <ArtifactTabs projectId={61} activeArtifactId={7} onSelect={vi.fn()} />
      </form>,
    );
    const controls = await screen.findByRole("group", { name: "Project components" });
    await user.click(within(controls).getByRole("button", { name: "Add artifact" }));
    const dialog = await screen.findByRole("dialog", { name: "Add an artifact" });
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));

    expect(screen.queryByRole("dialog", { name: "Add an artifact" })).not.toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
    expect(authFetch).toHaveBeenCalledTimes(1);
  });
});
