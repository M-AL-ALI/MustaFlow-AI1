import {
  ZERO_PROMPT_QUEUE_BOUNDARY_SEMANTICS,
  ZERO_PROMPT_QUEUE_RUN_PHASES,
  ZERO_PROMPT_QUEUE_UNKNOWN_PHASE,
  parseZeroRunLoopPhaseEvent,
} from "@workspace/ora-contracts";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { authFetch } from "@/lib/api-fetch";
import {
  ZeroPromptQueueDrawer,
  normalizePromptQueuePayload,
  promptQueueLandingMessage,
  selectPromptQueueError,
} from "./zero-prompt-queue-drawer";

vi.mock("@/lib/api-fetch", () => ({ authFetch: vi.fn() }));

const mockedAuthFetch = vi.mocked(authFetch);

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function queuePayload(
  items: Array<{ id: string; position: number; currentText: string; state?: string }>,
  truncated = false,
) {
  return {
    semantics: "zero-prompt-queue-v1",
    projectId: "7",
    items: items.map((item) => ({
      ...item,
      state: item.state ?? "queued",
      references: [],
      terminalEvidence: null,
    })),
    returnedItems: items.length,
    truncated,
  };
}

const PHASE_COPY = {
  between_steps: "Zero is between steps. The next queued prompt can join now.",
  createChatCompletion:
    "Zero is preparing the next response. Queued prompts will join at the next between-step pause.",
  parallel_tool_batch:
    "Zero is running a group of tools. Queued prompts will join after that group finishes.",
  serial_tool_call: "Zero is using a tool. Queued prompts will join after that tool finishes.",
  executeSingleFileWrite:
    "Zero is saving one file. Queued prompts will join after that file is safely written.",
  executeBatchFileWrite:
    "Zero is saving a group of files. Queued prompts will join after the whole group is safely written.",
  finalize_check:
    "Zero is reviewing the result. Queued prompts will join after this review finishes.",
  auto_check: "Zero is checking the work. Queued prompts will join after this check finishes.",
  post_loop_check:
    "Zero is completing the final checks. Queued prompts will join when those checks finish.",
  e2e_smoke: "Zero is testing the finished app. Queued prompts will join after this test finishes.",
  e2e_auto_fix:
    "Zero is repairing a test result. Queued prompts will join after the repair finishes.",
  project_files_commit:
    "Zero is saving the project version. Queued prompts will join after that save finishes.",
  runPostWriteMigrationSync:
    "Zero is updating the project's database setup. Queued prompts will join after that update finishes.",
  production_publish:
    "Zero is publishing the app. Queued prompts will join after publishing reaches a safe pause.",
} as const;

describe("Zero prompt queue drawer", () => {
  beforeEach(() => mockedAuthFetch.mockReset());
  afterEach(cleanup);

  it("uses the shared semantics and validates real phase events without guessing", () => {
    expect(
      parseZeroRunLoopPhaseEvent(
        JSON.stringify({
          semantics: ZERO_PROMPT_QUEUE_BOUNDARY_SEMANTICS,
          phase: "executeSingleFileWrite",
        }),
      ),
    ).toBe("executeSingleFileWrite");
    expect(
      parseZeroRunLoopPhaseEvent(
        JSON.stringify({ semantics: "old-semantics", phase: "between_steps" }),
      ),
    ).toBe(ZERO_PROMPT_QUEUE_UNKNOWN_PHASE);
    expect(
      parseZeroRunLoopPhaseEvent(
        JSON.stringify({
          semantics: ZERO_PROMPT_QUEUE_BOUNDARY_SEMANTICS,
          phase: "display-label-guess",
        }),
      ),
    ).toBe(ZERO_PROMPT_QUEUE_UNKNOWN_PHASE);
    expect(parseZeroRunLoopPhaseEvent("not json")).toBe(ZERO_PROMPT_QUEUE_UNKNOWN_PHASE);
  });

  it("pins a plain and honest waiting message for every declared phase", () => {
    expect(
      Object.fromEntries(
        ZERO_PROMPT_QUEUE_RUN_PHASES.map((phase) => [phase, promptQueueLandingMessage(41, phase)]),
      ),
    ).toEqual(PHASE_COPY);
  });

  it("distinguishes no active run, a telemetry gap, and an unknown phase", () => {
    expect(promptQueueLandingMessage(null, null)).toBe(
      "Zero is not running right now. Queued prompts will wait for the next run.",
    );
    expect(promptQueueLandingMessage(41, null)).toBe(
      "Zero's current step is unavailable because a phase update has not arrived. Queued prompts will wait for the next known safe point.",
    );
    expect(promptQueueLandingMessage(41, ZERO_PROMPT_QUEUE_UNKNOWN_PHASE)).toBe(
      "Zero reported a step this version does not recognize. Queued prompts will wait for the next known safe point.",
    );
  });

  it("sorts queued items by explicit position and excludes terminal records", async () => {
    mockedAuthFetch.mockResolvedValue(
      response(
        queuePayload([
          { id: "second", position: 2, currentText: "Second" },
          { id: "deleted", position: 3, currentText: "Removed", state: "deleted" },
          { id: "first", position: 1, currentText: "First" },
        ]),
      ),
    );

    render(
      <ZeroPromptQueueDrawer projectId={7} activeTaskId={null} phase={null} onClose={() => {}} />,
    );

    const list = await screen.findByRole("list", { name: "Prompt order" });
    expect(
      within(list)
        .getAllByRole("listitem")
        .map((item) => item.textContent),
    ).toEqual([expect.stringContaining("First"), expect.stringContaining("Second")]);
    expect(screen.queryByText("Removed")).not.toBeInTheDocument();
  });

  it("supports add, reorder, edit, and delete through the governed routes", async () => {
    const payload = queuePayload([
      { id: "first", position: 1, currentText: "First" },
      { id: "second", position: 2, currentText: "Second" },
    ]);
    mockedAuthFetch.mockImplementation(async (_path, init) =>
      response(init?.method ? { snapshot: payload, event: {}, warnings: [] } : payload),
    );
    const user = userEvent.setup();

    render(
      <ZeroPromptQueueDrawer
        projectId={7}
        activeTaskId={41}
        phase="serial_tool_call"
        onClose={() => {}}
      />,
    );
    await screen.findByText("First");

    await user.type(screen.getByRole("textbox", { name: "New queued prompt" }), "Third");
    await user.click(screen.getByRole("button", { name: "Add to queue" }));
    await waitFor(() => expect(mockedAuthFetch).toHaveBeenCalledTimes(3));
    expect(mockedAuthFetch.mock.calls[1]).toEqual([
      "/api/projects/7/prompt-queue",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ position: 3, text: "Third", references: [] }),
      }),
    ]);

    await user.click(screen.getByRole("button", { name: "Move prompt 2 up" }));
    await waitFor(() => expect(mockedAuthFetch).toHaveBeenCalledTimes(5));
    expect(mockedAuthFetch.mock.calls[3]).toEqual([
      "/api/projects/7/prompt-queue/second/position",
      expect.objectContaining({ method: "PATCH", body: JSON.stringify({ position: 1 }) }),
    ]);

    await user.click(screen.getByRole("button", { name: "Edit prompt 1" }));
    const edit = screen.getByRole("textbox", { name: "Edit queued prompt 1" });
    await user.clear(edit);
    await user.type(edit, "First edited");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(mockedAuthFetch).toHaveBeenCalledTimes(7));
    expect(mockedAuthFetch.mock.calls[5]).toEqual([
      "/api/projects/7/prompt-queue/first",
      expect.objectContaining({ method: "PATCH", body: JSON.stringify({ text: "First edited" }) }),
    ]);

    await user.click(screen.getByRole("button", { name: "Delete prompt 1" }));
    await waitFor(() => expect(mockedAuthFetch).toHaveBeenCalledTimes(9));
    expect(mockedAuthFetch.mock.calls[7]).toEqual([
      "/api/projects/7/prompt-queue/first",
      { method: "DELETE" },
    ]);
  });

  it("bounds the drawer at 50 records and explains truncation", async () => {
    const items = Array.from({ length: 51 }, (_, index) => ({
      id: `item-${index + 1}`,
      position: index + 1,
      currentText: `Prompt ${index + 1}`,
    }));
    mockedAuthFetch.mockResolvedValue(response(queuePayload(items, true)));

    render(
      <ZeroPromptQueueDrawer projectId={7} activeTaskId={null} phase={null} onClose={() => {}} />,
    );

    const list = await screen.findByRole("list", { name: "Prompt order" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(50);
    expect(screen.getByRole("status")).toHaveTextContent(
      "Only the first 50 queue records are shown.",
    );
  });

  it("shows a one-sentence empty state", async () => {
    mockedAuthFetch.mockResolvedValue(response(queuePayload([])));

    render(
      <ZeroPromptQueueDrawer projectId={7} activeTaskId={null} phase={null} onClose={() => {}} />,
    );

    expect(
      await screen.findByText("No prompts are queued. Add one to line up Zero's next task."),
    ).toBeInTheDocument();
  });

  it("surfaces a governed refusal verbatim and never renders raw technical errors", async () => {
    expect(
      selectPromptQueueError({
        code: "queue_full",
        error: "This queue already has 50 prompts. Remove or promote one before adding another.",
      }),
    ).toBe("This queue already has 50 prompts. Remove or promote one before adding another.");
    expect(
      selectPromptQueueError({
        code: "23505",
        error: "duplicate key violates postgres constraint zero_prompt_queue_items_position",
      }),
    ).toBe("The queued prompts could not be updated. Please try again.");
    expect(
      selectPromptQueueError({
        code: "queue_full",
        error: "postgres constraint details",
      }),
    ).toBe("The queued prompts could not be updated. Please try again.");
  });

  it("renders a governed API refusal verbatim", async () => {
    mockedAuthFetch.mockResolvedValueOnce(response(queuePayload([]))).mockResolvedValueOnce(
      response(
        {
          code: "queue_full",
          error: "This queue already has 50 prompts. Remove or promote one before adding another.",
        },
        409,
      ),
    );
    const user = userEvent.setup();

    render(
      <ZeroPromptQueueDrawer projectId={7} activeTaskId={null} phase={null} onClose={() => {}} />,
    );
    await screen.findByText("No prompts are queued. Add one to line up Zero's next task.");
    await user.type(screen.getByRole("textbox", { name: "New queued prompt" }), "Next");
    await user.click(screen.getByRole("button", { name: "Add to queue" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "This queue already has 50 prompts. Remove or promote one before adding another.",
    );
  });

  it("does not render raw technical response detail", async () => {
    mockedAuthFetch.mockResolvedValue(
      response(
        {
          code: "23505",
          error: "duplicate key violates postgres constraint zero_prompt_queue_items_position",
        },
        500,
      ),
    );

    render(
      <ZeroPromptQueueDrawer projectId={7} activeTaskId={null} phase={null} onClose={() => {}} />,
    );

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("The queued prompts could not be updated. Please try again.");
    expect(alert).not.toHaveTextContent(/postgres|constraint|23505/i);
  });

  it("normalizes malformed payloads without displaying response internals", () => {
    expect(normalizePromptQueuePayload({ error: "raw database body" })).toEqual({
      items: [],
      truncated: false,
    });
  });
});
