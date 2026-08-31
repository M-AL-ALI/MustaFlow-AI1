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
