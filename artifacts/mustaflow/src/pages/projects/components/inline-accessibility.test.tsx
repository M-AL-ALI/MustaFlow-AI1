import { render, screen } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { ProjectSuggestion } from "@workspace/api-client-react";
import { InlineActivityStream } from "./inline-activity-stream";
import { InlineBuilderError } from "./inline-builder-error";
import { InlineIdeas } from "./inline-ideas";
import { InlineNarrationStream } from "./inline-narration-stream";
import { InlineRunGroup } from "./inline-run-group";
import { QATapeStepsInline } from "./qa-tape-inline";
import { JumpToLatestButton } from "./smart-auto-scroll";

beforeAll(() => {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn().mockImplementation(() => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  });
});

describe("inline thread accessibility and motion", () => {
  it("announces live activity and narration through restrained logs", () => {
    render(
      <>
        <InlineActivityStream entries={[{ id: 1, kind: "writing", label: "Writing code" }]} live />
        <InlineNarrationStream entries={[{ id: 2, text: "Updating your app." }]} live />
      </>,
    );

    const logs = screen.getAllByRole("log");
    expect(logs).toHaveLength(2);
    for (const log of logs) expect(log).toHaveAttribute("aria-live", "polite");
    expect(screen.getByTestId("active-activity-icon")).toHaveClass("motion-safe:animate-pulse");
  });

  it("gives QA, errors, progress, and jump actions explicit semantics", () => {
    render(
      <>
        <QATapeStepsInline
          live
          steps={[
            {
              phase: "interaction",
              status: "running",
              message: "Clicked Add task",
            },
          ]}
        />
        <InlineBuilderError message="The preview did not start." />
        <InlineRunGroup stepCount={3} live progress={{ stepIndex: 3, stepCap: 25 }}>
          <span>Details</span>
        </InlineRunGroup>
        <JumpToLatestButton busy onJump={vi.fn()} />
      </>,
    );

    expect(screen.getAllByRole("log")).toHaveLength(1);
    expect(screen.getByRole("alert")).toHaveTextContent("The preview did not start.");
    expect(screen.getByLabelText("Build progress: step 3 of 25")).toBeVisible();
    expect(screen.getByRole("button", { name: "Jump to latest activity" })).toHaveClass(
      "motion-reduce:transition-none",
    );
  });

  it("exposes ideas controls to keyboard and assistive technology", () => {
    const idea = {
      id: 9,
      projectId: 1,
      taskId: 2,
      title: "Add search",
      description: "Help people find saved items.",
      prompt: "Add accessible search to the saved-items view.",
      category: "feature",
      status: "pending",
      createdAt: new Date().toISOString(),
    } as ProjectSuggestion;

    render(<InlineIdeas ideas={[idea]} onBuild={vi.fn()} onSave={vi.fn()} onDismiss={vi.fn()} />);

    expect(screen.getByRole("button", { name: /New ideas/ })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    expect(screen.getByRole("button", { name: "Save Add search in Ideas" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Edit Add search before building" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Dismiss Add search" })).toBeVisible();
  });
});
