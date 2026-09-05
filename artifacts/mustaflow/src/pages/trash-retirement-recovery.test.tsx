import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { authFetch } from "@/lib/api-fetch";
import TrashPage from "./trash";

const mocks = vi.hoisted(() => ({
  projects: [] as Array<Record<string, unknown>>,
  restore: vi.fn(),
  toast: vi.fn(),
  refresh: vi.fn(),
}));
vi.mock("@/lib/api-fetch", () => ({ authFetch: vi.fn() }));
vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: mocks.refresh }),
}));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: mocks.toast }) }));
vi.mock("@workspace/api-client-react", () => ({
  useListTrashedProjects: () => ({ data: mocks.projects, isPending: false, isError: false }),
  useRestoreProject: () => ({ mutate: mocks.restore, isPending: false }),
  getListTrashedProjectsQueryKey: () => ["trash"],
  getListProjectsQueryKey: () => ["projects"],
  getGetProjectsSummaryQueryKey: () => ["summary"],
}));
vi.mock("./trash-permanent-deletion", () => ({
  describePurgeDueAt: () => "Automatic deletion is scheduled.",
  describePurgeState: () => null,
  isPurgeInProgress: (state: string) => ["accepted", "running"].includes(state),
  ProjectPermanentDeletionControl: () => null,
}));

function response(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}
function status(overrides: Record<string, unknown> = {}) {
  return {
    projectId: 49,
    operationId: "old-operation-49",
    state: "completed",
    completedAt: "2026-08-31T12:00:00Z",
    completionEvidenceCurrent: false,
    reconciliationEligible: true,
    reconciliationBlockedCode: null,
    ...overrides,
  };
}

describe("Trash retirement evidence recovery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authFetch).mockReset();
    mocks.projects = [
      {
        id: 49,
        name: "Legacy project",
        retirementState: "completed",
        restoreAllowed: false,
        restoreBlockedCode: "project_retirement_cleanup_unverified",
        retirementOperationId: "old-operation-49",
        reconciliationEligible: true,
        reconciliationBlockedCode: null,
        purgeState: null,
      },
    ];
    mocks.refresh.mockResolvedValue(undefined);
  });
  afterEach(() => vi.useRealTimers());

  it("offers verification for old completed evidence and waits for fresh proof before Restore", async () => {
    const user = userEvent.setup();
    vi.mocked(authFetch)
      .mockResolvedValueOnce(
        response(
          {
            projectId: 49,
            operationId: "repair-49",
            state: "accepted",
            code: "project_retirement_reconciliation_accepted",
          },
          202,
        ),
      )
      .mockResolvedValueOnce(
        response(
          status({
            operationId: "repair-49",
            state: "running",
            completedAt: null,
            reconciliationEligible: false,
          }),
        ),
      )
      .mockResolvedValueOnce(
        response(
          status({
            operationId: "repair-49",
            completionEvidenceCurrent: true,
            reconciliationEligible: false,
          }),
        ),
      );
    const { rerender } = render(<TrashPage />);
    expect(screen.getByRole("button", { name: 'Restore project "Legacy project"' })).toBeDisabled();
    expect(screen.getByText(/earlier cleanup needs verification/u)).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Verify cleanup" }));
    expect(authFetch).toHaveBeenCalledWith("/api/projects/49/retirement/retry", { method: "POST" });
    expect(await screen.findByText(/verification is in progress/u)).toBeVisible();
    expect(screen.queryByRole("button", { name: "Verify cleanup" })).not.toBeInTheDocument();
    expect(mocks.restore).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Check status" }));
    expect(await screen.findByText("Cleanup is verified. Refreshing Trash...")).toBeVisible();
    await waitFor(() => expect(mocks.refresh.mock.calls.length).toBeGreaterThanOrEqual(6));
    mocks.projects[0] = { ...mocks.projects[0], restoreAllowed: true, restoreBlockedCode: null };
    rerender(<TrashPage />);
    expect(screen.getByRole("button", { name: 'Restore project "Legacy project"' })).toBeEnabled();
    expect(mocks.restore).not.toHaveBeenCalled();
  });

  it("handles the live typed 409 from a stale enabled Restore button with recovery", async () => {
    mocks.projects[0] = { ...mocks.projects[0], restoreAllowed: true };
    mocks.restore.mockImplementation((_input, callbacks) =>
      callbacks.onError({
        data: { code: "project_retirement_cleanup_unverified", error: "private provider body" },
      }),
    );
    const user = userEvent.setup();
    render(<TrashPage />);
    await user.click(screen.getByRole("button", { name: 'Restore project "Legacy project"' }));
    expect(screen.getByRole("button", { name: 'Restore project "Legacy project"' })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Verify cleanup" })).toBeVisible();
    expect(mocks.toast).toHaveBeenCalledWith(
      expect.objectContaining({ description: expect.stringContaining("Use cleanup recovery") }),
    );
    expect(JSON.stringify(mocks.toast.mock.calls)).not.toContain("private provider body");
  });

  it.each([
    ["project_retirement_reconciliation_limit_reached", /reached its retry limit/u],
    [
      "project_retirement_provider_configuration_unavailable",
      /waiting for platform configuration/u,
    ],
    ["project_retirement_retry_not_allowed", /needs support review/u],
  ])("makes typed refusal %s actionable without retry loops", async (code, message) => {
    const user = userEvent.setup();
    vi.mocked(authFetch).mockResolvedValueOnce(response({ code, error: "private raw error" }, 409));
    render(<TrashPage />);
    await user.click(screen.getByRole("button", { name: "Verify cleanup" }));
    expect(await screen.findByText(message)).toBeVisible();
    expect(screen.queryByRole("button", { name: "Verify cleanup" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Check status" })).toBeEnabled();
    expect(authFetch).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("private raw error")).not.toBeInTheDocument();
  });

  it("treats a persisted 503 cleanup_pending as accepted rather than submitting twice", async () => {
    const user = userEvent.setup();
    vi.mocked(authFetch)
      .mockResolvedValueOnce(
        response(
          {
            projectId: 49,
            operationId: "repair-49",
            state: "accepted",
            code: "project_retirement_cleanup_pending",
          },
          503,
        ),
      )
      .mockResolvedValueOnce(
        response(
          status({
            operationId: "repair-49",
            state: "accepted",
            completedAt: null,
            reconciliationEligible: false,
          }),
        ),
      );
    render(<TrashPage />);
    await user.click(screen.getByRole("button", { name: "Verify cleanup" }));
    expect(await screen.findByText(/verification is in progress/u)).toBeVisible();
    expect(screen.queryByRole("button", { name: "Verify cleanup" })).not.toBeInTheDocument();
    expect(
      vi.mocked(authFetch).mock.calls.filter((call) => call[1]?.method === "POST"),
    ).toHaveLength(1);
  });

  it("rejects another project's receipt and never trusts a completed label alone", async () => {
    const user = userEvent.setup();
    vi.mocked(authFetch).mockResolvedValueOnce(
      response(status({ projectId: 50, completionEvidenceCurrent: true })),
    );
    render(<TrashPage />);
    await user.click(screen.getByRole("button", { name: "Check status" }));
    expect(await screen.findByText(/Could not check cleanup/u)).toBeVisible();
    expect(screen.getByRole("button", { name: 'Restore project "Legacy project"' })).toBeDisabled();
    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  it("bounds automatic status checks and exposes manual continuation", async () => {
    vi.useFakeTimers();
    vi.mocked(authFetch).mockResolvedValue(
      response(status({ state: "running", completedAt: null, reconciliationEligible: false })),
    );
    render(<TrashPage />);
    await act(async () => {
      screen.getByRole("button", { name: "Check status" }).click();
    });
    for (let count = 0; count < 31; count += 1) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2_000);
      });
    }
    expect(authFetch).toHaveBeenCalledTimes(31);
    expect(screen.getByText(/Automatic status checks paused/u)).toBeVisible();
    expect(screen.getByRole("button", { name: "Check status" })).toBeEnabled();
    expect(mocks.restore).not.toHaveBeenCalled();
  });

  it("does not turn an old completed status label into restore permission", async () => {
    const user = userEvent.setup();
    vi.mocked(authFetch).mockResolvedValueOnce(response(status()));
    render(<TrashPage />);
    await user.click(screen.getByRole("button", { name: "Check status" }));
    expect(screen.getByRole("button", { name: 'Restore project "Legacy project"' })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Verify cleanup" })).toBeEnabled();
    expect(mocks.refresh).not.toHaveBeenCalled();
    expect(mocks.restore).not.toHaveBeenCalled();
  });

  it("offers no restore recovery after purge starts", () => {
    mocks.projects[0] = { ...mocks.projects[0], purgeState: "running" };
    render(<TrashPage />);
    expect(screen.getByRole("button", { name: 'Restore project "Legacy project"' })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Verify cleanup" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Check status" })).not.toBeInTheDocument();
  });
});
