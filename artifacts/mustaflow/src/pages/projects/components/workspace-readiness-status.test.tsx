// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useWorkspaceReadiness } from "@/hooks/use-workspace-readiness";
import {
  parseWorkspaceReadinessReceipt,
  type WorkspaceReadinessReceipt,
} from "@/lib/workspace-readiness";
import { WorkspaceReadinessStatus } from "./workspace-readiness-status";

const mocks = vi.hoisted(() => ({ fetchReceipt: vi.fn() }));
vi.mock("@/lib/workspace-readiness", async () => ({
  ...(await vi.importActual<typeof import("@/lib/workspace-readiness")>(
    "@/lib/workspace-readiness",
  )),
  fetchWorkspaceReadinessReceipt: mocks.fetchReceipt,
}));

function terminalFor(taskId = 13, versionId = 11) {
  return {
    schema: "zero-terminal-v1",
    taskId,
    intent: "mutate",
    intentReceiptId: 17,
    completedAt: "2026-09-17T00:00:00.000Z",
    outcome: "mutation_succeeded",
    runStatus: "completed",
    evidence: {
      versionId,
      diffRef: { kind: "task_report", taskId, revision: 1 },
      preview: { promised: true, state: "ready", receiptId: "preview-" + taskId },
    },
  };
}
const terminal = terminalFor();

function unknownReceipt(projectId = 7, taskId = 13, versionId = 11) {
  const context = { projectId, subject: { versionId, taskId, revision: 1 as const } };
  return parseWorkspaceReadinessReceipt(
    {
      schema: "workspace-readiness-v1",
      ...context,
      state: "unknown",
      cause: "evidence_unavailable",
      unblock: "recheck",
    },
    context,
    "preview",
  );
}
function blockedReceipt() {
  const context = { projectId: 7, subject: { versionId: 11, taskId: 13, revision: 1 as const } };
  return parseWorkspaceReadinessReceipt(
    {
      schema: "workspace-readiness-v1",
      ...context,
      state: "blocked",
      cause: "architect_required",
      unblock: "retry_architect",
      evidence: { receiptId: "review-skipped-13" },
    },
    context,
    "preview",
  );
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function Harness({
  projectId = 7,
  value = terminal,
  env = "testing",
}: {
  projectId?: number;
  value?: unknown;
  env?: string;
}) {
  const readiness = useWorkspaceReadiness({ projectId, terminal: value, env, surface: "preview" });
  return (
    <>
      <WorkspaceReadinessStatus
        receipt={readiness.receipt}
        pending={readiness.pending}
        onRecheck={readiness.recheck}
      />
      <output data-testid="receipt-project">
        {readiness.receipt?.readiness.projectId ?? "none"}
      </output>
      <output data-testid="can-publish">
        {String(readiness.receipt?.presentation.canPublish ?? false)}
      </output>
    </>
  );
}

beforeEach(() => {
  mocks.fetchReceipt.mockReset();
});
afterEach(() => {
  cleanup();
});

describe("actionable workspace readiness", () => {
  it("reads the exact saved subject without starting another build", async () => {
    mocks.fetchReceipt.mockResolvedValue(unknownReceipt());
    render(<Harness />);
    await screen.findByRole("button", { name: "Check again" });
    expect(mocks.fetchReceipt).toHaveBeenCalledTimes(1);
    expect(mocks.fetchReceipt).toHaveBeenCalledWith({
      projectId: 7,
      terminal,
      env: "testing",
      surface: "preview",
    });
    expect(screen.getByTestId("can-publish").textContent).toBe("false");
  });

  it("makes Check again actionable and disables it during a fresh read", async () => {
    const retry = deferred<WorkspaceReadinessReceipt>();
    mocks.fetchReceipt.mockResolvedValueOnce(unknownReceipt()).mockReturnValueOnce(retry.promise);
    render(<Harness />);
    fireEvent.click(await screen.findByRole("button", { name: "Check again" }));
    const pending = screen.getByRole("button", { name: "Checking..." }) as HTMLButtonElement;
    expect(pending.disabled).toBe(true);
    expect(screen.getByTestId("receipt-project").textContent).toBe("none");
    expect(screen.getByTestId("can-publish").textContent).toBe("false");
    fireEvent.click(pending);
    expect(mocks.fetchReceipt).toHaveBeenCalledTimes(2);
    await act(async () => {
      retry.resolve(blockedReceipt());
    });
    expect(screen.getByText("Review has not run")).toBeTruthy();
    expect(screen.getByText("Next step: Run review again")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Run review again" })).toBeNull();
    expect(screen.getByTestId("can-publish").textContent).toBe("false");
  });

  it("keeps errors private and restores a retry action", async () => {
    mocks.fetchReceipt.mockRejectedValue(new Error("private transport detail"));
    render(<Harness />);
    await screen.findByRole("button", { name: "Check again" });
    expect(screen.getByText("Status could not be verified")).toBeTruthy();
    expect(screen.queryByText("private transport detail")).toBeNull();
    expect(screen.getByTestId("can-publish").textContent).toBe("false");
  });

  it("does not display a late receipt from the previously selected project", async () => {
    const old = deferred<WorkspaceReadinessReceipt>();
    const next = deferred<WorkspaceReadinessReceipt>();
    mocks.fetchReceipt.mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise);
    const otherTerminal = terminalFor(23, 21);
    const view = render(<Harness />);
    view.rerender(<Harness projectId={8} value={otherTerminal} />);
    expect(screen.getByTestId("receipt-project").textContent).toBe("none");
    await act(async () => {
      next.resolve(unknownReceipt(8, 23, 21));
    });
    expect(screen.getByTestId("receipt-project").textContent).toBe("8");
    await act(async () => {
      old.resolve(unknownReceipt());
    });
    expect(screen.getByTestId("receipt-project").textContent).toBe("8");
  });

  it("clears the prior receipt when the environment changes", async () => {
    const next = deferred<WorkspaceReadinessReceipt>();
    mocks.fetchReceipt.mockResolvedValueOnce(unknownReceipt()).mockReturnValueOnce(next.promise);
    const view = render(<Harness />);
    await screen.findByRole("button", { name: "Check again" });
    view.rerender(<Harness env="production" />);
    expect(screen.getByTestId("receipt-project").textContent).toBe("none");
    expect(mocks.fetchReceipt).toHaveBeenLastCalledWith({
      projectId: 7,
      terminal,
      env: "production",
      surface: "preview",
    });
    await act(async () => {
      next.resolve(unknownReceipt());
    });
  });

  it("does not fetch without a valid mutation terminal", () => {
    render(<Harness value={null} />);
    expect(mocks.fetchReceipt).not.toHaveBeenCalled();
    expect(screen.queryByRole("status", { name: "Workspace readiness" })).toBeNull();
    expect(screen.getByTestId("can-publish").textContent).toBe("false");
  });

  it("does not accept an in-flight receipt after the terminal is removed", async () => {
    const old = deferred<WorkspaceReadinessReceipt>();
    mocks.fetchReceipt.mockReturnValueOnce(old.promise);
    const view = render(<Harness />);
    view.rerender(<Harness value={null} />);
    await act(async () => {
      old.resolve(unknownReceipt());
    });
    expect(screen.getByTestId("receipt-project").textContent).toBe("none");
    expect(screen.queryByRole("status", { name: "Workspace readiness" })).toBeNull();
  });

  it("ignores a late rejected request after unmounting", async () => {
    const old = deferred<WorkspaceReadinessReceipt>();
    mocks.fetchReceipt.mockReturnValueOnce(old.promise);
    const view = render(<Harness />);
    view.unmount();
    await act(async () => {
      old.reject(new Error("late private detail"));
    });
    expect(screen.queryByRole("status")).toBeNull();
  });
});
