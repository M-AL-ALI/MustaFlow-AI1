import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { authFetch } from "@/lib/api-fetch";
import TrashPage from "./trash";
import {
  describePurgeDueAt,
  ProjectPermanentDeletionControl,
  type PurgeableTrashedProject,
} from "./trash-permanent-deletion";

vi.mock("@/lib/api-fetch", () => ({ authFetch: vi.fn() }));
const pageMocks = vi.hoisted(() => ({
  trashedProjects: [] as Array<Record<string, unknown>>,
  restore: vi.fn(),
  invalidateQueries: vi.fn(),
  toast: vi.fn(),
  reverificationChallenges: 0,
}));
vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: pageMocks.invalidateQueries }),
}));
vi.mock("@workspace/api-client-react", () => ({
  useListTrashedProjects: () => ({
    data: pageMocks.trashedProjects,
    isPending: false,
    isError: false,
    refetch: vi.fn(),
  }),
  useRestoreProject: () => ({
    mutate: pageMocks.restore,
    isPending: false,
    variables: undefined,
  }),
  getListTrashedProjectsQueryKey: () => ["trashed-projects"],
  getListProjectsQueryKey: () => ["projects"],
  getGetProjectsSummaryQueryKey: () => ["project-summary"],
}));
vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: pageMocks.toast }),
}));
vi.mock("@clerk/react", () => ({
  useReverification:
    (fetcher: (...args: unknown[]) => unknown) =>
    async (...args: unknown[]) => {
      let result = await fetcher(...args);
      if (
        result &&
        typeof result === "object" &&
        "clerk_error" in result &&
        (result as { clerk_error?: { reason?: unknown } }).clerk_error?.reason ===
          "reverification-error"
      ) {
        pageMocks.reverificationChallenges += 1;
        result = await fetcher(...args);
      }
      return result;
    },
}));
vi.mock("@clerk/react/errors", () => ({
  isReverificationCancelledError: (error: unknown) =>
    Boolean(error && typeof error === "object" && "code" in error && error.code === "cancelled"),
}));

const PROJECT: PurgeableTrashedProject = {
  id: 72,
  name: "Customer portal",
  purgeDueAt: "2026-09-30T12:00:00.000Z",
  restoreAllowed: true,
  retirementState: "completed",
  purgeState: null,
};

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn().mockResolvedValue(body),
  } as unknown as Response;
}

function impactResponse() {
  return jsonResponse({
    projectId: PROJECT.id,
    name: PROJECT.name,
    deletedAt: "2026-08-31T12:00:00.000Z",
    purgeDueAt: PROJECT.purgeDueAt,
    restoreAllowed: true,
    retirementState: "completed",
    purgeState: null,
    willDelete: ["Project code, versions, secrets, and assets", "NabuFlow runtime resources"],
    willDetach: ["External GitHub repository", "Purchased domain registration"],
    requiresReverification: true,
  });
}

function clerkReverificationHint() {
  return jsonResponse(
    {
      clerk_error: {
        type: "forbidden",
        reason: "reverification-error",
        metadata: { reverification: { level: "first_factor", afterMinutes: 10 } },
      },
    },
    403,
  );
}

function renderControl(project: PurgeableTrashedProject = PROJECT) {
  const onPurgeActivityChange = vi.fn();
  const onStateRefresh = vi.fn().mockResolvedValue(undefined);
  render(
    <ProjectPermanentDeletionControl
      project={project}
      onPurgeActivityChange={onPurgeActivityChange}
      onStateRefresh={onStateRefresh}
    />,
  );
  return { onPurgeActivityChange, onStateRefresh };
}

describe("Trash permanent deletion", () => {
  beforeEach(() => {
    vi.mocked(authFetch).mockReset();
    pageMocks.trashedProjects = [];
    pageMocks.restore.mockReset();
    pageMocks.invalidateQueries.mockReset();
    pageMocks.toast.mockReset();
    pageMocks.reverificationChallenges = 0;
    pageMocks.invalidateQueries.mockResolvedValue(undefined);
  });

  afterEach(() => vi.useRealTimers());

  it("uses the server purge date for a truthful countdown", () => {
    expect(
      describePurgeDueAt("2026-09-30T12:00:00.000Z", Date.parse("2026-09-23T12:00:00.000Z")),
    ).toMatch(/^Automatic deletion in 7 days \(.+\)\.$/u);
    expect(describePurgeDueAt(null, Date.now())).toBe("Automatic deletion date is unavailable.");
    expect(
      describePurgeDueAt("2026-09-01T12:00:00.000Z", Date.parse("2026-09-02T12:00:00.000Z")),
    ).toMatch(/^Automatic deletion is due now \(.+\)\.$/u);
  });

  it("shows the bounded deletion impact and requires the exact project name", async () => {
    const user = userEvent.setup();
    vi.mocked(authFetch).mockResolvedValueOnce(impactResponse());
    renderControl();

    await user.click(
      screen.getByRole("button", { name: `Delete project "${PROJECT.name}" permanently` }),
    );

    expect(await screen.findByText("Project code, versions, secrets, and assets")).toBeVisible();
    expect(screen.getByText("External GitHub repository")).toBeVisible();
    expect(screen.getByText(/sign-in will be verified again/u)).toBeVisible();

    const confirmation = screen.getByRole("textbox");
    expect(confirmation).toHaveFocus();
    const submit = screen.getByRole("button", { name: "Verify and delete permanently" });
    expect(submit).toBeDisabled();
    await user.type(confirmation, "Customer");
    expect(submit).toBeDisabled();
    await user.clear(confirmation);
    await user.type(confirmation, PROJECT.name);
    expect(submit).toBeEnabled();
  });

  it("passes Clerk's first-factor hint through useReverification and retries only after the challenge", async () => {
    const user = userEvent.setup();
    vi.mocked(authFetch)
      .mockResolvedValueOnce(impactResponse())
      .mockResolvedValueOnce(clerkReverificationHint())
      .mockResolvedValueOnce(
        jsonResponse(
          {
            code: "project_purge_accepted",
            operationId: "purge-reverified-72",
            state: "accepted",
            statusUrl: "/api/project-purge-operations/purge-reverified-72",
          },
          202,
        ),
      );
    renderControl();

    await user.click(
      screen.getByRole("button", { name: `Delete project "${PROJECT.name}" permanently` }),
    );
    await user.type(await screen.findByRole("textbox"), PROJECT.name);
    await user.click(screen.getByRole("button", { name: "Verify and delete permanently" }));

    await waitFor(() => expect(pageMocks.reverificationChallenges).toBe(1));
    const deleteCalls = vi
      .mocked(authFetch)
      .mock.calls.filter(
        ([url, options]) => url.endsWith("/permanent") && options?.method === "DELETE",
      );
    expect(deleteCalls).toHaveLength(2);
    expect(screen.getByText("Close", { selector: "button.rounded-md" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Cancel" })).not.toBeInTheDocument();
  });

  it("sends a client idempotency key and earns success only from terminal evidence", async () => {
    const user = userEvent.setup();
    const operationId = "purge-operation-72";
    vi.mocked(authFetch)
      .mockResolvedValueOnce(impactResponse())
      .mockResolvedValueOnce(
        jsonResponse(
          {
            code: "project_purge_accepted",
            operationId,
            state: "accepted",
            statusUrl: `/api/project-purge-operations/${operationId}`,
          },
          202,
        ),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          id: operationId,
          projectId: PROJECT.id,
          state: "completed",
          stage: "absence",
          trigger: "manual",
          dueAt: null,
          attemptCount: 1,
          failureCode: null,
          failureRetryable: null,
          retryAllowed: false,
          nextAttemptAt: null,
          terminalEvidence: {
            schema: "project-purge-terminal-v1",
            outcome: "completed",
            inventoryDigestSha256: "a".repeat(64),
            absenceDigestSha256: "b".repeat(64),
            removedResourceCount: 12,
            detachedResourceCount: 2,
          },
        }),
      );
    const { onPurgeActivityChange, onStateRefresh } = renderControl();

    await user.click(
      screen.getByRole("button", { name: `Delete project "${PROJECT.name}" permanently` }),
    );
    await user.type(await screen.findByRole("textbox"), PROJECT.name);
    await user.click(screen.getByRole("button", { name: "Verify and delete permanently" }));

    expect(screen.queryByText(/Project permanently deleted/u)).not.toBeInTheDocument();
    await waitFor(() => expect(authFetch).toHaveBeenCalledTimes(2));
    const deleteRequest = vi.mocked(authFetch).mock.calls[1];
    expect(deleteRequest?.[0]).toBe(`/api/projects/${PROJECT.id}/permanent`);
    expect(deleteRequest?.[1]).toEqual(
      expect.objectContaining({
        method: "DELETE",
        body: JSON.stringify({ projectName: PROJECT.name }),
      }),
    );
    const headers = new Headers(deleteRequest?.[1]?.headers);
    expect(headers.get("Idempotency-Key")).toMatch(/^[0-9a-f-]{32,}$/iu);
    expect(onPurgeActivityChange).toHaveBeenCalledWith(PROJECT.id, true);

    expect(
      await screen.findByText(
        "Project permanently deleted. Its NabuFlow-owned data and resources were verified absent.",
        {},
        { timeout: 4_000 },
      ),
    ).toBeVisible();
    expect(authFetch).toHaveBeenLastCalledWith(`/api/project-purge-operations/${operationId}`, {
      method: "GET",
    });
    await user.click(screen.getByRole("button", { name: "Done" }));
    await waitFor(() => expect(onStateRefresh).toHaveBeenCalledTimes(1));
    expect(onPurgeActivityChange).toHaveBeenLastCalledWith(PROJECT.id, false);
  });

  it("never renders a raw server error or claims an unknown request did nothing", async () => {
    const user = userEvent.setup();
    const rawError = "SQLSTATE_23503 raw provider response must never reach the user";
    vi.mocked(authFetch)
      .mockResolvedValueOnce(impactResponse())
      .mockResolvedValueOnce(
        jsonResponse({ code: "unexpected_internal_failure", message: rawError }, 500),
      );
    renderControl();

    await user.click(
      screen.getByRole("button", { name: `Delete project "${PROJECT.name}" permanently` }),
    );
    await user.type(await screen.findByRole("textbox"), PROJECT.name);
    await user.click(screen.getByRole("button", { name: "Verify and delete permanently" }));

    expect(
      await screen.findByText(
        "We could not confirm whether permanent deletion started. Try again to check the same request safely.",
      ),
    ).toBeVisible();
    expect(screen.queryByText(rawError)).not.toBeInTheDocument();
    expect(screen.queryByText(/Project permanently deleted/u)).not.toBeInTheDocument();
  });

  it("replays an ambiguous response with the same destructive idempotency key", async () => {
    const user = userEvent.setup();
    vi.mocked(authFetch)
      .mockResolvedValueOnce(impactResponse())
      .mockResolvedValueOnce(jsonResponse(null, 202))
      .mockResolvedValueOnce(
        jsonResponse(
          {
            code: "project_purge_accepted",
            operationId: "purge-response-loss-72",
            state: "accepted",
            statusUrl: "/api/project-purge-operations/purge-response-loss-72",
          },
          202,
        ),
      );
    renderControl();

    await user.click(
      screen.getByRole("button", { name: `Delete project "${PROJECT.name}" permanently` }),
    );
    await user.type(await screen.findByRole("textbox"), PROJECT.name);
    const submit = screen.getByRole("button", { name: "Verify and delete permanently" });
    await user.click(submit);
    expect(
      await screen.findByText(/could not confirm whether permanent deletion started/iu),
    ).toBeVisible();
    await user.click(submit);

    const deleteCalls = vi
      .mocked(authFetch)
      .mock.calls.filter(
        ([url, options]) => url.endsWith("/permanent") && options?.method === "DELETE",
      );
    expect(deleteCalls).toHaveLength(2);
    expect(new Headers(deleteCalls[0]?.[1]?.headers).get("Idempotency-Key")).toBe(
      new Headers(deleteCalls[1]?.[1]?.headers).get("Idempotency-Key"),
    );
  });

  it("recovers an accepted deletion receipt after refresh and labels dismissal truthfully", async () => {
    const user = userEvent.setup();
    const refreshed = {
      ...PROJECT,
      restoreAllowed: false,
      purgeState: "accepted",
      purgeOperationId: "purge-refresh-72",
      purgeTrigger: "manual",
      purgeStage: "assets",
      purgeAttemptCount: 1,
      purgeFailureCode: null,
      purgeFailureRetryable: null,
      purgeRetryAllowed: false,
      purgeNextAttemptAt: null,
    };
    vi.mocked(authFetch).mockResolvedValueOnce(impactResponse());
    const { onStateRefresh } = renderControl(refreshed);

    await user.click(
      screen.getByRole("button", {
        name: `View permanent deletion progress for project "${PROJECT.name}"`,
      }),
    );

    expect(await screen.findByText("Removing files that only this project uses.")).toBeVisible();
    expect(screen.getByText("Close", { selector: "button.rounded-md" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Cancel" })).not.toBeInTheDocument();
    await user.click(screen.getByText("Close", { selector: "button.rounded-md" }));
    await waitFor(() => expect(onStateRefresh).toHaveBeenCalledTimes(1));
  });

  it("offers a fresh, reverified retry only for a retryable failed receipt", async () => {
    const user = userEvent.setup();
    const operationId = "purge-retry-72";
    vi.mocked(authFetch)
      .mockResolvedValueOnce(impactResponse())
      .mockResolvedValueOnce(
        jsonResponse(
          {
            code: "project_purge_accepted",
            operationId,
            state: "accepted",
            statusUrl: `/api/project-purge-operations/${operationId}`,
          },
          202,
        ),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          id: operationId,
          projectId: PROJECT.id,
          state: "failed",
          stage: "inventory",
          trigger: "manual",
          dueAt: null,
          attemptCount: 5,
          failureCode: "project_purge_attempts_exhausted",
          failureRetryable: true,
          retryAllowed: true,
          nextAttemptAt: null,
          terminalEvidence: {
            schema: "project-purge-terminal-v1",
            outcome: "failed",
            stage: "inventory",
            failureCode: "project_purge_attempts_exhausted",
            retryable: true,
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse(
          {
            code: "project_purge_accepted",
            operationId,
            state: "accepted",
            statusUrl: `/api/project-purge-operations/${operationId}`,
          },
          202,
        ),
      );
    renderControl();

    await user.click(
      screen.getByRole("button", { name: `Delete project "${PROJECT.name}" permanently` }),
    );
    await user.type(await screen.findByRole("textbox"), PROJECT.name);
    await user.click(screen.getByRole("button", { name: "Verify and delete permanently" }));
    expect(
      await screen.findByText(
        "The retry limit was reached safely. Verify again to start a fresh bounded deletion cycle.",
        undefined,
        {
          timeout: 4_000,
        },
      ),
    ).toBeVisible();

    const retryInput = screen.getByRole("textbox");
    expect(retryInput).toHaveFocus();
    await user.type(retryInput, PROJECT.name);
    await user.click(screen.getByRole("button", { name: "Verify and retry permanent deletion" }));

    const deleteCalls = vi
      .mocked(authFetch)
      .mock.calls.filter(
        ([url, options]) => url.endsWith("/permanent") && options?.method === "DELETE",
      );
    expect(deleteCalls).toHaveLength(2);
    const firstKey = new Headers(deleteCalls[0]?.[1]?.headers).get("Idempotency-Key");
    const retryKey = new Headers(deleteCalls[1]?.[1]?.headers).get("Idempotency-Key");
    expect(firstKey).toBeTruthy();
    expect(retryKey).toBeTruthy();
    expect(retryKey).not.toBe(firstKey);
  });

  it("does not offer retry for a non-retryable failed operation", async () => {
    const user = userEvent.setup();
    vi.mocked(authFetch).mockResolvedValueOnce(impactResponse());
    renderControl({
      ...PROJECT,
      restoreAllowed: false,
      purgeState: "failed",
      purgeOperationId: "purge-stopped-72",
      purgeTrigger: "expiry",
      purgeStage: "database",
      purgeAttemptCount: 5,
      purgeFailureCode: "project_purge_database_release_failed",
      purgeFailureRetryable: false,
      purgeRetryAllowed: false,
      purgeNextAttemptAt: null,
    });

    await user.click(
      screen.getByRole("button", {
        name: `View permanent deletion progress for project "${PROJECT.name}"`,
      }),
    );
    expect(await screen.findByText(/Contact support for help/u)).toBeVisible();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /retry permanent deletion/iu }),
    ).not.toBeInTheDocument();
  });

  it("refuses deletion while retirement is incomplete or a purge is active", () => {
    const { rerender } = render(
      <ProjectPermanentDeletionControl
        project={{ ...PROJECT, retirementState: "running" }}
        onPurgeActivityChange={vi.fn()}
        onStateRefresh={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: /Delete project/u })).toBeDisabled();
    expect(screen.getByText("Cleanup must finish before permanent deletion.")).toBeVisible();

    rerender(
      <ProjectPermanentDeletionControl
        project={{ ...PROJECT, purgeState: "running" }}
        onPurgeActivityChange={vi.fn()}
        onStateRefresh={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: /Delete project/u })).toBeDisabled();
    expect(screen.getByText(/progress receipt is unavailable/u)).toBeVisible();
  });

  it("wires server lifecycle fields into the Trash page controls", () => {
    pageMocks.trashedProjects = [
      {
        id: PROJECT.id,
        ownerId: "owner-test",
        name: PROJECT.name,
        description: "A recoverable project",
        deletedAt: "2026-08-31T12:00:00.000Z",
        serverNow: "2026-09-01T00:00:00.000Z",
        purgeDueAt: "2099-09-30T12:00:00.000Z",
        restoreAllowed: true,
        retirementState: "completed",
        purgeState: null,
      },
    ];
    const { rerender } = render(<TrashPage />);

    expect(screen.getByText(/permanently deleted automatically/u)).toBeVisible();
    expect(screen.getByText(/^Automatic deletion in \d+ days/u)).toBeVisible();
    expect(screen.getByRole("button", { name: `Restore project "${PROJECT.name}"` })).toBeEnabled();
    expect(
      screen.getByRole("button", { name: `Delete project "${PROJECT.name}" permanently` }),
    ).toBeEnabled();

    pageMocks.trashedProjects = [
      {
        ...pageMocks.trashedProjects[0],
        restoreAllowed: false,
        purgeState: "running",
      },
    ];
    rerender(<TrashPage />);
    expect(
      screen.getByRole("button", { name: `Restore project "${PROJECT.name}"` }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: `Delete project "${PROJECT.name}" permanently` }),
    ).toBeDisabled();
    expect(screen.getByText(/progress receipt is unavailable/u)).toBeVisible();

    pageMocks.trashedProjects = [
      {
        ...pageMocks.trashedProjects[0],
        purgeState: "failed",
        purgeOperationId: "purge-auto-72",
        purgeTrigger: "expiry",
        purgeStage: "runtime",
        purgeAttemptCount: 2,
        purgeFailureCode: "project_purge_runtime_release_failed",
        purgeFailureRetryable: true,
        purgeRetryAllowed: true,
        purgeNextAttemptAt: "2099-10-01T12:00:00.000Z",
      },
    ];
    rerender(<TrashPage />);
    expect(screen.getByText(/will retry automatically around/u)).toBeVisible();
    expect(
      screen.getByRole("button", {
        name: `View permanent deletion progress for project "${PROJECT.name}"`,
      }),
    ).toBeEnabled();
  });

  it("updates the server-clock countdown while Trash remains open", () => {
    vi.useFakeTimers();
    const serverNow = new Date("2026-09-01T00:00:00.000Z");
    vi.setSystemTime(new Date("2099-12-31T23:59:59.000Z"));
    pageMocks.trashedProjects = [
      {
        id: PROJECT.id,
        ownerId: "owner-test",
        name: PROJECT.name,
        deletedAt: "2026-08-31T12:00:00.000Z",
        serverNow: serverNow.toISOString(),
        purgeDueAt: new Date(serverNow.getTime() + 24 * 60 * 60 * 1_000 + 15_000).toISOString(),
        restoreAllowed: true,
        retirementState: "completed",
        purgeState: "scheduled",
      },
    ];
    render(<TrashPage />);
    expect(screen.getByText(/^Automatic deletion in 2 days/u)).toBeVisible();

    act(() => vi.advanceTimersByTime(30_000));

    expect(screen.getByText(/^Automatic deletion in 1 day /u)).toBeVisible();
    expect(screen.getByText("Automatic permanent deletion is scheduled.")).toBeVisible();
  });

  it("wraps long project names instead of clipping destructive confirmation", async () => {
    const user = userEvent.setup();
    const longName = `Long project ${"word".repeat(45)}`;
    const project = { ...PROJECT, name: longName };
    vi.mocked(authFetch).mockResolvedValueOnce(
      jsonResponse({
        projectId: PROJECT.id,
        name: longName,
        deletedAt: "2026-08-31T12:00:00.000Z",
        purgeDueAt: PROJECT.purgeDueAt,
        restoreAllowed: true,
        retirementState: "completed",
        purgeState: null,
        willDelete: ["Project-owned data"],
        willDetach: [],
        requiresReverification: true,
      }),
    );
    renderControl(project);

    await user.click(
      screen.getByRole("button", { name: `Delete project "${longName}" permanently` }),
    );
    const confirmation = await screen.findByRole("textbox");
    expect(confirmation).toHaveFocus();
    expect(screen.getByText(longName, { selector: "span" })).toHaveClass(
      "[overflow-wrap:anywhere]",
    );
  });
});
