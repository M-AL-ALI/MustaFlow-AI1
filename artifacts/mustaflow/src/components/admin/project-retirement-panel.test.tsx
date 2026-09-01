import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { authFetch } from "@/lib/api-fetch";
import {
  AUTHORIZED_PROJECT_RETIREMENT_IDS,
  PROJECT_RETIREMENT_CONFIRMATION,
  ProjectRetirementPanel,
} from "./project-retirement-panel";

vi.mock("@/lib/api-fetch", () => ({ authFetch: vi.fn() }));

const EXACT_PROJECT_IDS = [
  1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27,
  28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 52,
  53, 54, 55,
];

function jsonResponse(body: unknown, status = 202): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn().mockResolvedValue(body),
  } as unknown as Response;
}

describe("ProjectRetirementPanel", () => {
  beforeEach(() => {
    vi.mocked(authFetch).mockReset();
  });

  it("uses the exact rollout manifest and visibly excludes Project 51", () => {
    render(<ProjectRetirementPanel />);

    expect(AUTHORIZED_PROJECT_RETIREMENT_IDS).toEqual(EXACT_PROJECT_IDS);
    expect(AUTHORIZED_PROJECT_RETIREMENT_IDS).toHaveLength(54);
    expect(AUTHORIZED_PROJECT_RETIREMENT_IDS).not.toContain(51);
    expect(screen.getByText("Project 51 is excluded and will not be sent.")).toBeVisible();
  });

  it("requires the exact typed confirmation before enabling retirement", async () => {
    const user = userEvent.setup();
    render(<ProjectRetirementPanel />);
    const input = screen.getByRole("textbox");
    const submit = screen.getByRole("button", {
      name: "Retire 54 authorized test projects",
    });

    expect(submit).toBeDisabled();
    await user.type(input, "RETIRE PROJECTS 1-51");
    expect(submit).toBeDisabled();
    await user.clear(input);
    await user.type(input, PROJECT_RETIREMENT_CONFIRMATION);
    expect(submit).toBeEnabled();
  });

  it("posts the exact body through authFetch, prevents double-submit, and requires re-confirmation", async () => {
    const user = userEvent.setup();
    let resolveRequest!: (response: Response) => void;
    vi.mocked(authFetch).mockReturnValue(
      new Promise<Response>((resolve) => {
        resolveRequest = resolve;
      }),
    );
    render(<ProjectRetirementPanel />);
    const input = screen.getByRole("textbox");
    const submit = screen.getByRole("button", {
      name: "Retire 54 authorized test projects",
    });
    await user.type(input, PROJECT_RETIREMENT_CONFIRMATION);

    fireEvent.click(submit);
    fireEvent.click(submit);

    expect(authFetch).toHaveBeenCalledTimes(1);
    expect(authFetch).toHaveBeenCalledWith(
      "/api/admin/projects/retirement/batch",
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/json" },
      }),
    );
    const request = vi.mocked(authFetch).mock.calls[0]?.[1];
    expect(JSON.parse(String(request?.body))).toEqual({ projectIds: EXACT_PROJECT_IDS });

    resolveRequest(
      jsonResponse({
        code: "project_retirement_batch_accepted",
        receipts: [],
      }),
    );
    await screen.findByText("The authorized retirement batch was accepted.");
    await waitFor(() => expect(input).toHaveValue(""));
    expect(
      screen.getByRole("button", { name: "Retire 54 authorized test projects" }),
    ).toBeDisabled();

    await user.type(input, PROJECT_RETIREMENT_CONFIRMATION);
    await user.click(screen.getByRole("button", { name: "Retire 54 authorized test projects" }));
    await waitFor(() => expect(authFetch).toHaveBeenCalledTimes(2));
    const replayRequest = vi.mocked(authFetch).mock.calls[1]?.[1];
    expect(JSON.parse(String(replayRequest?.body))).toEqual({ projectIds: EXACT_PROJECT_IDS });
  });

  it("renders plain-language typed receipts and status URLs", async () => {
    const user = userEvent.setup();
    vi.mocked(authFetch).mockResolvedValue(
      jsonResponse({
        code: "project_retirement_batch_partially_accepted",
        receipts: [
          {
            projectId: 1,
            operationId: "retirement-1",
            state: "accepted",
            cleanupScheduled: true,
            cleanupScheduleState: "enqueued",
            statusUrl: "/api/projects/1/retirement",
          },
          {
            projectId: 2,
            operationId: "retirement-2",
            state: "accepted",
            cleanupScheduled: true,
            cleanupScheduleState: "already_scheduled",
            statusUrl: "/api/projects/2/retirement",
          },
          {
            projectId: 3,
            operationId: "retirement-3",
            state: "completed",
            cleanupComplete: true,
            statusUrl: "/api/projects/3/retirement",
          },
          {
            projectId: 4,
            state: "refused",
            code: "project_retirement_managed_addon_unverified",
            error: "Managed add-on evidence is incomplete.",
          },
          { projectId: 5, state: "not_found" },
          {
            projectId: 6,
            operationId: "retirement-6",
            state: "accepted",
            cleanupScheduled: false,
            cleanupScheduleState: "unavailable",
          },
        ],
      }),
    );
    render(<ProjectRetirementPanel />);
    await user.type(screen.getByRole("textbox"), PROJECT_RETIREMENT_CONFIRMATION);
    await user.click(screen.getByRole("button", { name: "Retire 54 authorized test projects" }));

    expect(
      await screen.findByText(
        "The batch was partially accepted. Review the refused projects below.",
      ),
    ).toBeVisible();
    expect(screen.getByText("Cleanup was accepted and queued.")).toBeVisible();
    expect(
      screen.getByText("Cleanup was already scheduled; the existing receipt was reused."),
    ).toBeVisible();
    expect(
      screen.getByText("Cleanup is complete; the existing receipt was replayed."),
    ).toBeVisible();
    expect(screen.getByText("Not retired — Managed add-on evidence is incomplete.")).toBeVisible();
    expect(screen.getByText("Project was not found.")).toBeVisible();
    expect(screen.getByText("Moved to Trash; cleanup scheduling is pending.")).toBeVisible();

    const statusLinks = screen.getAllByRole("link");
    expect(statusLinks.map((link) => link.getAttribute("href"))).toEqual([
      "/api/projects/1/retirement",
      "/api/projects/2/retirement",
      "/api/projects/3/retirement",
      "/api/projects/6/retirement",
    ]);
  });

  it("loads one project retirement status with an authenticated read-only request", async () => {
    const user = userEvent.setup();
    vi.mocked(authFetch).mockResolvedValueOnce(
      jsonResponse(
        {
          operationId: "retirement-5",
          projectId: 5,
          state: "running",
          attemptCount: 2,
          progress: { internal: "not rendered" },
          failureCode: null,
          failureTarget: null,
          createdAt: "2026-08-31T12:00:00.000Z",
          startedAt: "2026-08-31T12:01:00.000Z",
          completedAt: null,
          reconciliationEligible: false,
        },
        200,
      ),
    );
    render(<ProjectRetirementPanel />);
    await user.type(screen.getByRole("spinbutton", { name: "Retired project ID" }), "5");
    await user.click(screen.getByRole("button", { name: "Check retirement status" }));

    expect(authFetch).toHaveBeenCalledWith("/api/projects/5/retirement", { method: "GET" });
    expect(await screen.findByText("Cleanup is running.")).toBeVisible();
    expect(screen.getByText("Attempt count: 2.")).toBeVisible();
    expect(screen.queryByText("not rendered")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Retry governed cleanup for Project 5" }),
    ).not.toBeInTheDocument();
  });

  it("rejects a non-positive project ID without making a request", async () => {
    const user = userEvent.setup();
    render(<ProjectRetirementPanel />);
    await user.type(screen.getByRole("spinbutton", { name: "Retired project ID" }), "0");
    await user.click(screen.getByRole("button", { name: "Check retirement status" }));

    expect(await screen.findByText("Enter a positive whole-number project ID.")).toBeVisible();
    expect(authFetch).not.toHaveBeenCalled();
  });

  it("explicitly refuses Project 51 without making a request", async () => {
    const user = userEvent.setup();
    render(<ProjectRetirementPanel />);
    await user.type(screen.getByRole("spinbutton", { name: "Retired project ID" }), "51");
    await user.click(screen.getByRole("button", { name: "Check retirement status" }));

    expect(
      await screen.findByText("Project 51 is excluded from the authorized retirement manifest."),
    ).toBeVisible();
    expect(authFetch).not.toHaveBeenCalled();
  });

  it("clears a loaded receipt and validation failure when the project ID changes", async () => {
    const user = userEvent.setup();
    vi.mocked(authFetch).mockResolvedValueOnce(
      jsonResponse(
        {
          operationId: "retirement-5",
          projectId: 5,
          state: "running",
          attemptCount: 2,
          failureCode: null,
          completedAt: null,
          reconciliationEligible: false,
        },
        200,
      ),
    );
    render(<ProjectRetirementPanel />);
    const input = screen.getByRole("spinbutton", { name: "Retired project ID" });
    await user.type(input, "5");
    await user.click(screen.getByRole("button", { name: "Check retirement status" }));
    expect(await screen.findByText("Cleanup is running.")).toBeVisible();

    await user.clear(input);
    await user.type(input, "51");
    expect(screen.queryByText("Cleanup is running.")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Check retirement status" }));
    expect(
      await screen.findByText("Project 51 is excluded from the authorized retirement manifest."),
    ).toBeVisible();

    await user.clear(input);
    await user.type(input, "27");
    expect(
      screen.queryByText("Project 51 is excluded from the authorized retirement manifest."),
    ).not.toBeInTheDocument();
  });

  it("rejects a typed-looking retirement status returned with a non-200 HTTP status", async () => {
    const user = userEvent.setup();
    vi.mocked(authFetch).mockResolvedValueOnce(
      jsonResponse(
        {
          operationId: "retirement-5",
          projectId: 5,
          state: "failed",
          attemptCount: 4,
          failureCode: "project_retirement_attempts_exhausted",
          completedAt: "2026-08-31T12:05:00.000Z",
          reconciliationEligible: true,
        },
        409,
      ),
    );
    render(<ProjectRetirementPanel />);
    await user.type(screen.getByRole("spinbutton", { name: "Retired project ID" }), "5");
    await user.click(screen.getByRole("button", { name: "Check retirement status" }));

    expect(
      await screen.findByText(
        "Retirement status could not be loaded. Check the project ID and try again.",
      ),
    ).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Retry governed cleanup for Project 5" }),
    ).not.toBeInTheDocument();
  });

  it("shows retry only when the server marks the loaded receipt reconciliation-eligible", async () => {
    const user = userEvent.setup();
    vi.mocked(authFetch)
      .mockResolvedValueOnce(
        jsonResponse(
          {
            operationId: "retirement-27",
            projectId: 27,
            state: "failed",
            attemptCount: 2,
            failureCode: "project_retirement_operation_unavailable",
            completedAt: null,
            reconciliationEligible: false,
          },
          200,
        ),
      )
      .mockResolvedValueOnce(
        jsonResponse(
          {
            operationId: "retirement-27",
            projectId: 27,
            state: "failed",
            attemptCount: 4,
            failureCode: "project_retirement_completion_evidence_incomplete",
            completedAt: "2026-08-31T12:05:00.000Z",
            reconciliationEligible: false,
          },
          200,
        ),
      )
      .mockResolvedValueOnce(
        jsonResponse(
          {
            operationId: "retirement-27",
            projectId: 27,
            state: "failed",
            attemptCount: 4,
            failureCode: "project_retirement_attempts_exhausted",
            completedAt: "2026-08-31T12:05:00.000Z",
            reconciliationEligible: true,
          },
          200,
        ),
      );
    render(<ProjectRetirementPanel />);
    await user.type(screen.getByRole("spinbutton", { name: "Retired project ID" }), "27");
    await user.click(screen.getByRole("button", { name: "Check retirement status" }));

    expect(
      await screen.findByText("Cleanup attempt failed and remains eligible for automatic retry."),
    ).toBeVisible();
    expect(screen.getByText("The cleanup operation was temporarily unavailable.")).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Retry governed cleanup for Project 27" }),
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Check retirement status" }));
    expect(await screen.findByText("Cleanup ended with a terminal failure.")).toBeVisible();
    expect(screen.getByText("The cleanup completion evidence is incomplete.")).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Retry governed cleanup for Project 27" }),
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Check retirement status" }));
    expect(screen.getByText("Governed cleanup exhausted its automatic attempts.")).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Retry governed cleanup for Project 27" }),
    ).toBeVisible();
  });

  it("locks a loaded terminal retry and renders the accepted status receipt", async () => {
    const user = userEvent.setup();
    let resolveRetry!: (response: Response) => void;
    vi.mocked(authFetch)
      .mockResolvedValueOnce(
        jsonResponse(
          {
            operationId: "retirement-44",
            projectId: 44,
            state: "failed",
            attemptCount: 4,
            failureCode: "project_retirement_runtime_destroy_unverified",
            completedAt: "2026-08-31T12:05:00.000Z",
            reconciliationEligible: true,
          },
          200,
        ),
      )
      .mockReturnValueOnce(
        new Promise<Response>((resolve) => {
          resolveRetry = resolve;
        }),
      );
    render(<ProjectRetirementPanel />);
    await user.type(screen.getByRole("spinbutton", { name: "Retired project ID" }), "44");
    await user.click(screen.getByRole("button", { name: "Check retirement status" }));
    const retry = await screen.findByRole("button", {
      name: "Retry governed cleanup for Project 44",
    });

    fireEvent.click(retry);
    fireEvent.click(retry);

    expect(authFetch).toHaveBeenCalledTimes(2);
    expect(authFetch).toHaveBeenNthCalledWith(2, "/api/projects/44/retirement/retry", {
      method: "POST",
    });
    resolveRetry(
      jsonResponse(
        {
          code: "project_retirement_cleanup_pending",
          operationId: "reconciliation-44",
          projectId: 44,
          state: "accepted",
          cleanupScheduled: false,
          cleanupScheduleState: "unavailable",
          retryable: true,
        },
        503,
      ),
    );

    expect(await screen.findByText("Moved to Trash; cleanup scheduling is pending.")).toBeVisible();
    expect(screen.getByRole("link", { name: "/api/projects/44/retirement" })).toHaveAttribute(
      "href",
      "/api/projects/44/retirement",
    );
    expect(
      screen.queryByRole("button", { name: "Retry governed cleanup for Project 44" }),
    ).not.toBeInTheDocument();
  });

  it.each([
    [
      "an accepted body returned as HTTP 200",
      200,
      {
        code: "project_retirement_reconciliation_accepted",
        operationId: "reconciliation-5",
        projectId: 5,
        state: "accepted",
        cleanupScheduled: true,
        cleanupScheduleState: "enqueued",
        statusUrl: "/api/projects/5/retirement",
      },
    ],
    [
      "an unscheduled body returned as HTTP 202",
      202,
      {
        code: "project_retirement_reconciliation_accepted",
        operationId: "reconciliation-5",
        projectId: 5,
        state: "accepted",
        cleanupScheduled: false,
        cleanupScheduleState: "unavailable",
        statusUrl: "/api/projects/5/retirement",
      },
    ],
    [
      "a scheduled body returned as HTTP 503",
      503,
      {
        code: "project_retirement_cleanup_pending",
        operationId: "reconciliation-5",
        projectId: 5,
        state: "accepted",
        cleanupScheduled: true,
        cleanupScheduleState: "enqueued",
        retryable: true,
        statusUrl: "/api/projects/5/retirement",
      },
    ],
    [
      "an external status URL",
      202,
      {
        code: "project_retirement_reconciliation_accepted",
        operationId: "reconciliation-5",
        projectId: 5,
        state: "accepted",
        cleanupScheduled: true,
        cleanupScheduleState: "enqueued",
        statusUrl: "https://example.invalid/retirement/5",
      },
    ],
  ])("rejects %s", async (_label, retryStatus, retryBody) => {
    const user = userEvent.setup();
    vi.mocked(authFetch)
      .mockResolvedValueOnce(
        jsonResponse(
          {
            operationId: "retirement-5",
            projectId: 5,
            state: "failed",
            attemptCount: 4,
            failureCode: "project_retirement_attempts_exhausted",
            completedAt: "2026-08-31T12:05:00.000Z",
            reconciliationEligible: true,
          },
          200,
        ),
      )
      .mockResolvedValueOnce(jsonResponse(retryBody, retryStatus));
    render(<ProjectRetirementPanel />);
    await user.type(screen.getByRole("spinbutton", { name: "Retired project ID" }), "5");
    await user.click(screen.getByRole("button", { name: "Check retirement status" }));
    await user.click(
      await screen.findByRole("button", { name: "Retry governed cleanup for Project 5" }),
    );

    expect(
      await screen.findByText("Governed cleanup could not be retried. Try again shortly."),
    ).toBeVisible();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });

  it("does not expose raw status errors or response bodies", async () => {
    const user = userEvent.setup();
    const rawError = `SQLSTATE_XX000: ${"private provider response ".repeat(20)}`;
    vi.mocked(authFetch).mockResolvedValueOnce(
      jsonResponse(
        {
          code: "project_retirement_not_found",
          error: rawError,
          internal: { responseBody: "must not render" },
        },
        404,
      ),
    );
    render(<ProjectRetirementPanel />);
    await user.type(screen.getByRole("spinbutton", { name: "Retired project ID" }), "5");
    await user.click(screen.getByRole("button", { name: "Check retirement status" }));

    expect(
      await screen.findByText(
        "Retirement status could not be loaded. Check the project ID and try again.",
      ),
    ).toBeVisible();
    expect(screen.queryByText(rawError)).not.toBeInTheDocument();
    expect(screen.queryByText("must not render")).not.toBeInTheDocument();
  });

  it("renders the allowlisted cache substage without exposing raw provider detail", async () => {
    const user = userEvent.setup();
    const rawProviderDetail = "Cloudflare response body and token scope must not render";
    vi.mocked(authFetch).mockResolvedValueOnce(
      jsonResponse(
        {
          operationId: "retirement-5",
          projectId: 5,
          state: "failed",
          attemptCount: 4,
          failureCode: "project_retirement_route_deactivation_unverified",
          completedAt: "2026-08-31T12:05:00.000Z",
          reconciliationEligible: false,
          progress: {
            route: {
              state: "failed",
              legacyHostnameKv: { state: "verified_absent" },
              hostnames: { total: 0, states: {}, stages: {}, raw: rawProviderDetail },
              runtimeRoutes: { total: 0, states: {}, raw: rawProviderDetail },
              cache: { state: "failed", raw: rawProviderDetail },
            },
            retainedLegacyRuntimePointers: { total: 0, reasons: {}, raw: rawProviderDetail },
            internal: rawProviderDetail,
          },
        },
        200,
      ),
    );
    render(<ProjectRetirementPanel />);
    await user.type(screen.getByRole("spinbutton", { name: "Retired project ID" }), "5");
    await user.click(screen.getByRole("button", { name: "Check retirement status" }));

    expect(await screen.findByText("Cache clearing could not be verified.")).toBeVisible();
    expect(screen.queryByText(rawProviderDetail)).not.toBeInTheDocument();
    expect(screen.queryByText(/project_retirement_/u)).not.toBeInTheDocument();
  });

  it("renders an allowlisted historical-runtime receipt in plain language", async () => {
    const user = userEvent.setup();
    vi.mocked(authFetch).mockResolvedValueOnce(
      jsonResponse(
        {
          operationId: "retirement-27",
          projectId: 27,
          state: "failed",
          attemptCount: 1,
          failureCode: "project_retirement_legacy_runtime_retained",
          completedAt: "2026-08-31T12:05:00.000Z",
          reconciliationEligible: false,
          progress: {
            route: {
              state: "verified_absent",
              legacyHostnameKv: { state: "verified_absent" },
              hostnames: { total: 0, states: {}, stages: {} },
              runtimeRoutes: { total: 0, states: {} },
              cache: { state: "purged" },
            },
            retainedLegacyRuntimePointers: {
              total: 1,
              reasons: { legacy_runtime_provider: 1 },
            },
          },
        },
        200,
      ),
    );
    render(<ProjectRetirementPanel />);
    await user.type(screen.getByRole("spinbutton", { name: "Retired project ID" }), "27");
    await user.click(screen.getByRole("button", { name: "Check retirement status" }));

    expect(
      await screen.findByText(
        "A historical runtime from the previous provider is retained for separate governed cleanup.",
      ),
    ).toBeVisible();
  });

  it("offers only the governed reconciliation retry, locks duplicate clicks, and renders its accepted receipt", async () => {
    const user = userEvent.setup();
    let resolveRetry!: (response: Response) => void;
    vi.mocked(authFetch)
      .mockResolvedValueOnce(
        jsonResponse({
          code: "project_retirement_batch_partially_accepted",
          receipts: [
            {
              projectId: 12,
              state: "refused",
              code: "project_retirement_reconciliation_required",
              error: "This project's earlier cleanup needs governed reconciliation.",
            },
            {
              projectId: 13,
              state: "refused",
              code: "project_retirement_managed_addon_unverified",
              error: "This project has an add-on whose safe removal cannot be verified yet.",
            },
          ],
        }),
      )
      .mockReturnValueOnce(
        new Promise<Response>((resolve) => {
          resolveRetry = resolve;
        }),
      );
    render(<ProjectRetirementPanel />);
    await user.type(screen.getByRole("textbox"), PROJECT_RETIREMENT_CONFIRMATION);
    await user.click(screen.getByRole("button", { name: "Retire 54 authorized test projects" }));

    const retry = await screen.findByRole("button", {
      name: "Retry governed cleanup for Project 12",
    });
    expect(
      screen.queryByRole("button", { name: "Retry governed cleanup for Project 13" }),
    ).not.toBeInTheDocument();

    fireEvent.click(retry);
    fireEvent.click(retry);

    expect(authFetch).toHaveBeenCalledTimes(2);
    expect(authFetch).toHaveBeenNthCalledWith(2, "/api/projects/12/retirement/retry", {
      method: "POST",
    });

    resolveRetry(
      jsonResponse({
        code: "project_retirement_reconciliation_accepted",
        operationId: "reconciliation-12",
        projectId: 12,
        state: "accepted",
        cleanupScheduled: true,
        cleanupScheduleState: "enqueued",
        queueJobId: "queue-12",
        statusUrl: "/api/projects/12/retirement",
      }),
    );

    expect(await screen.findByText("Cleanup was accepted and queued.")).toBeVisible();
    expect(screen.getByRole("link", { name: "/api/projects/12/retirement" })).toHaveAttribute(
      "href",
      "/api/projects/12/retirement",
    );
    expect(
      screen.queryByRole("button", { name: "Retry governed cleanup for Project 12" }),
    ).not.toBeInTheDocument();
  });

  it("does not expose raw retry errors", async () => {
    const user = userEvent.setup();
    const rawError = `SQLSTATE_XX000: ${"provider stack detail ".repeat(20)}`;
    vi.mocked(authFetch)
      .mockResolvedValueOnce(
        jsonResponse(
          {
            code: "project_retirement_batch_refused",
            receipts: [
              {
                projectId: 14,
                state: "refused",
                code: "project_retirement_reconciliation_required",
              },
            ],
          },
          409,
        ),
      )
      .mockResolvedValueOnce(
        jsonResponse(
          {
            code: "project_retirement_not_terminal",
            error: rawError,
          },
          409,
        ),
      );
    render(<ProjectRetirementPanel />);
    await user.type(screen.getByRole("textbox"), PROJECT_RETIREMENT_CONFIRMATION);
    await user.click(screen.getByRole("button", { name: "Retire 54 authorized test projects" }));
    await user.click(
      await screen.findByRole("button", {
        name: "Retry governed cleanup for Project 14",
      }),
    );

    expect(
      await screen.findByText(
        "This retirement receipt is not eligible for another governed cleanup.",
      ),
    ).toBeVisible();
    expect(screen.queryByText(rawError)).not.toBeInTheDocument();
  });

  it("does not expose technical, long, or unexpectedly thrown error text", async () => {
    const user = userEvent.setup();
    const technicalError = "SQLSTATE_23505: duplicate_key stack trace";
    const longError = `Cleanup failed: ${"provider detail ".repeat(20)}`;
    vi.mocked(authFetch).mockResolvedValueOnce(
      jsonResponse(
        {
          code: "project_retirement_batch_refused",
          receipts: [
            {
              projectId: 7,
              state: "refused",
              code: "project_retirement_database_exception_23505",
              error: technicalError,
            },
            {
              projectId: 8,
              state: "refused",
              code: "project_retirement_unknown_failure",
              error: longError,
            },
          ],
        },
        409,
      ),
    );
    const first = render(<ProjectRetirementPanel />);
    await user.type(screen.getByRole("textbox"), PROJECT_RETIREMENT_CONFIRMATION);
    await user.click(screen.getByRole("button", { name: "Retire 54 authorized test projects" }));

    expect(
      await screen.findAllByText("Not retired — This project could not be retired safely."),
    ).toHaveLength(2);
    expect(screen.queryByText(technicalError)).not.toBeInTheDocument();
    expect(screen.queryByText(longError)).not.toBeInTheDocument();
    expect(
      screen.queryByText(/project_retirement_database_exception_23505/u),
    ).not.toBeInTheDocument();

    first.unmount();
    const thrownText = "SQLSTATE_XX000: password=should-not-render";
    vi.mocked(authFetch).mockRejectedValueOnce(new Error(thrownText));
    render(<ProjectRetirementPanel />);
    await user.type(screen.getByRole("textbox"), PROJECT_RETIREMENT_CONFIRMATION);
    await user.click(screen.getByRole("button", { name: "Retire 54 authorized test projects" }));

    expect(
      await screen.findByText("The retirement request could not be completed. Try again shortly."),
    ).toBeVisible();
    expect(screen.queryByText(thrownText)).not.toBeInTheDocument();
  });
});
