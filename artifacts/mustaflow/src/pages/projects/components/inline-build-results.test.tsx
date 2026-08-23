import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { InlineBuildResults, type InlineBuildResultsReport } from "./inline-build-results";
import { authFetch } from "@/lib/api-fetch";

vi.mock("@/lib/api-fetch", () => ({ authFetch: vi.fn() }));

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
      "Outcome unavailable for this older run",
    );
    expect(screen.getByTestId("inline-build-summary")).not.toHaveTextContent("Updated");
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

  it("composes saved-version truth with subject-bound readiness before celebrating", async () => {
    const terminal = {
      schema: "zero-terminal-v1",
      taskId: 13,
      intent: "mutate",
      intentReceiptId: 17,
      completedAt: "2026-08-22T00:00:00.000Z",
      outcome: "mutation_succeeded",
      runStatus: "completed",
      evidence: {
        versionId: 64,
        diffRef: { kind: "task_report", taskId: 13, revision: 1 },
        preview: { promised: true, state: "unavailable", cause: "preview_failed" },
      },
    };
    vi.mocked(authFetch).mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          workspaceReadiness: {
            schema: "workspace-readiness-v1",
            projectId: 7,
            subject: { versionId: 64, taskId: 13, revision: 1 },
            state: "blocked",
            cause: "preview_broken",
            unblock: "wait_or_retry_preview",
            evidence: { receiptId: "preview-64" },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    render(<InlineBuildResults report={report} terminal={terminal} projectId={7} />);

    await waitFor(() => expect(screen.getByTestId("inline-workspace-readiness")).toBeVisible());
    expect(screen.getByTestId("inline-workspace-readiness")).toHaveTextContent("Changes applied");
    expect(screen.getByTestId("inline-workspace-readiness")).toHaveTextContent(
      "Preview needs attention",
    );
    expect(screen.getByTestId("inline-workspace-readiness")).not.toHaveTextContent(
      "This version is ready",
    );
    expect(vi.mocked(authFetch).mock.calls[0]?.[0]).toContain("versionId=64&taskId=13&revision=1");
  });
});
