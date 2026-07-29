import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ProjectSuggestion } from "@workspace/api-client-react";
import { InlineIdeas } from "./inline-ideas";

function idea(id: number, title: string): ProjectSuggestion {
  return {
    id,
    projectId: 45,
    taskId: 901,
    title,
    description: `${title} description`,
    category: "improvement",
    prompt: `Build ${title.toLowerCase()}`,
    status: "pending",
    createdAt: "2026-07-28T12:00:00.000Z",
  };
}

describe("InlineIdeas", () => {
  it("keeps save, build, edit, and dismiss actions inline", () => {
    const onBuild = vi.fn();
    const onSave = vi.fn();
    const onDismiss = vi.fn();
    const ideas = [idea(1, "Keyboard shortcuts"), idea(2, "Empty state")];

    render(
      <InlineIdeas
        ideas={ideas}
        onBuild={onBuild}
        onSave={onSave}
        onDismiss={onDismiss}
      />,
    );

    expect(screen.getAllByTestId("inline-idea")).toHaveLength(2);
    fireEvent.click(screen.getAllByTitle("Save in Ideas")[0]!);
    expect(onSave).toHaveBeenCalledWith(ideas[0]);
    expect(screen.getByTitle("Saved in Ideas")).toBeDisabled();

    fireEvent.click(screen.getAllByText("Build")[0]!);
    expect(onBuild).toHaveBeenCalledWith(ideas[0]);

    fireEvent.click(screen.getAllByTitle("Edit before building")[0]!);
    const editor = screen.getByPlaceholderText("Edit the build request...");
    fireEvent.change(editor, { target: { value: "Build the edited idea" } });
    fireEvent.click(screen.getByText("Build with edits"));
    expect(onBuild).toHaveBeenCalledWith(ideas[0], "Build the edited idea");

    fireEvent.click(screen.getAllByTitle("Dismiss")[1]!);
    expect(onDismiss).toHaveBeenCalledWith(ideas[1]);
    expect(screen.getAllByTestId("inline-idea")).toHaveLength(1);
  });

  it("uses one quiet loading line while ideas are being generated", () => {
    render(
      <InlineIdeas
        ideas={[]}
        loading
        onBuild={vi.fn()}
        onSave={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );

    expect(screen.getByText("Finding useful next ideas...")).toBeVisible();
  });
});
