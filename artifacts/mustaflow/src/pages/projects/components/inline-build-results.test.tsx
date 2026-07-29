import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { InlineBuildResults, type InlineBuildResultsReport } from "./inline-build-results";

const report: InlineBuildResultsReport = {
  filesCreated: ["src/App.tsx", "src/components/Todo.tsx", "src/styles.css"],
  filesChanged: [],
  filesRemoved: [],
  filesUnchanged: [
    "package.json",
    "vite.config.ts",
    "index.html",
    "src/main.tsx",
    "src/lib/storage.ts",
    "src/types.ts",
    "tsconfig.json",
  ],
  warnings: [
    "Validation was partial because live-server infrastructure was unavailable; container-dependent checks were deferred.",
  ],
  checkSummary: "TypeScript passed; live preview validation was deferred.",
  checkRunsSummary: {
    passed: 2,
    warnings: 1,
    failed: 0,
    skipped: 1,
    warnChecks: ["preview"],
  },
  knowledgeApplied: [{ id: 7, title: "Keep forms keyboard accessible", category: "accessibility" }],
  versionId: 64,
};

describe("InlineBuildResults", () => {
  it("renders a quiet summary and collapsed result rows without report-card chrome", () => {
    render(<InlineBuildResults report={report} onOpenCheckpoint={vi.fn()} />);

    expect(screen.getByTestId("inline-build-summary")).toHaveTextContent(
      "Updated 3 project files.",
    );
    expect(screen.queryByText("Builder report")).not.toBeInTheDocument();
    expect(screen.getByTestId("inline-build-files")).not.toHaveAttribute("open");
    expect(screen.getByTestId("inline-build-checks")).not.toHaveAttribute("open");
    expect(screen.getByTestId("inline-build-lessons")).not.toHaveAttribute("open");
    expect(screen.getByText("3 created · 0 changed · 7 unchanged")).toBeVisible();
    expect(screen.getByText("2 passed · 1 warning · 0 failed · 1 skipped")).toBeVisible();
    expect(screen.getByTestId("inline-build-checkpoint")).toHaveTextContent(
      "Checkpoint saved — restore any time",
    );
  });

  it("expands files, checks, and lessons only when the user asks", async () => {
    const user = userEvent.setup();
    const onViewFile = vi.fn();
    const onSendMessage = vi.fn();
    render(
      <InlineBuildResults report={report} onViewFile={onViewFile} onSendMessage={onSendMessage} />,
    );

    expect(screen.queryByText("src/components/Todo.tsx")).not.toBeVisible();
    await user.click(screen.getByText("Files changed"));
    await user.click(screen.getByText("Checks"));
    await user.click(screen.getByText("Applied lessons"));

    await user.click(screen.getByText("src/components/Todo.tsx"));
    expect(onViewFile).toHaveBeenCalledWith("src/components/Todo.tsx");
    expect(screen.getByText(/TypeScript passed/)).toBeVisible();
    expect(screen.getByText("Keep forms keyboard accessible")).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Fix issues" }));
    expect(onSendMessage).toHaveBeenCalledWith(expect.stringContaining("preview"));
  });

  it("keeps the honest partial-validation disclosure when the warning is omitted", async () => {
    const user = userEvent.setup();
    render(<InlineBuildResults report={{ ...report, warnings: [] }} />);

    await user.click(screen.getByText("Checks"));

    expect(
      screen.getByText(
        "Build completed with partial validation — live-server infrastructure was unavailable, so container-dependent checks were deferred.",
      ),
    ).toBeVisible();
  });
});
