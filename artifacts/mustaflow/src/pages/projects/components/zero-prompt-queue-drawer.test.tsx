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
  items: Array<{
    id: string;
    position: number;
    currentText: string;
    state?: string;
    terminalEvidence?: Record<string, unknown> | null;
  }>,
  truncated = false,
) {
  return {
    semantics: "zero-prompt-queue-v1",
    projectId: "7",
    items: items.map((item) => {
      const state = item.state ?? "queued";
      const terminalEvidence =
        item.terminalEvidence !== undefined
          ? item.terminalEvidence
          : state === "promoted"
            ? {
                kind: "promoted",
                activeTurnId: `turn-${item.id}`,
                provenanceEventId: `event-${item.id}`,
                occurredAt: "2026-08-20T17:00:00.000Z",
              }
            : state === "deleted"
              ? {
                  kind: "deleted",
                  deletedBy: "owner-7",
                  provenanceEventId: `event-${item.id}`,
                  occurredAt: "2026-08-20T17:00:00.000Z",
                }
              : null;
      return { ...item, state, references: [], terminalEvidence };
    }),
    returnedItems: items.length,
    truncated,
  };
}

const PHASE_COPY = {
  between_steps: "Zero is between steps. Your prompts are saved for the next safe pause.",
  createChatCompletion:
    "Zero is preparing the next response. Your prompts are saved for the next safe pause.",
  parallel_tool_batch:
    "Zero is working through a group of actions. Your prompts are saved for the next safe pause.",
  serial_tool_call: "Zero is working on an action. Your prompts are saved for the next safe pause.",
  executeSingleFileWrite:
    "Zero is saving one file. Your prompts are saved for the next safe pause.",
  executeBatchFileWrite:
    "Zero is saving a group of files. Your prompts are saved for the next safe pause.",
  finalize_check: "Zero is reviewing the result. Your prompts are saved for the next safe pause.",
  auto_check: "Zero is checking the work. Your prompts are saved for the next safe pause.",
  post_loop_check:
    "Zero is completing the final checks. Your prompts are saved and will wait for the next run.",
  e2e_smoke:
    "Zero is testing the finished app. Your prompts are saved and will wait for the next run.",
  e2e_auto_fix:
    "Zero is repairing a test result. Your prompts are saved and will wait for the next run.",
  project_files_commit:
    "Zero is saving the project version. Your prompts are saved and will wait for the next run.",
  runPostWriteMigrationSync:
    "Zero is updating the project's database setup. Your prompts are saved and will wait for the next run.",
  production_publish:
    "Zero is publishing the app. Your prompts are saved and will wait for the next run.",
} as const;

const NEXT_RUN_PHASES = [
  "post_loop_check",
  "e2e_smoke",
  "e2e_auto_fix",
  "project_files_commit",
  "runPostWriteMigrationSync",
] as const;

describe("Zero prompt queue drawer", () => {
  beforeEach(() => mockedAuthFetch.mockReset());
  afterEach(() => {
    vi.restoreAllMocks();
    cleanup();
  });

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

  it("never claims that a prompt about to be entered can land immediately", () => {
    const activeCopy = ZERO_PROMPT_QUEUE_RUN_PHASES.map((phase) =>
      promptQueueLandingMessage(41, phase),
    );

    for (const message of activeCopy) {
      expect(message).not.toMatch(/join now|right away|immediat|lands now/i);
    }
  });

  it.each(NEXT_RUN_PHASES)("tells users that %s waits for the next run", (phase) => {
    expect(promptQueueLandingMessage(41, phase)).toContain(
      "Your prompts are saved and will wait for the next run.",
    );
  });

  it("distinguishes no active run, a telemetry gap, and an unknown phase", () => {
    expect(promptQueueLandingMessage(null, null)).toBe(
      "Zero is not running right now. Queued prompts will wait for the next run.",
    );
    expect(promptQueueLandingMessage(41, null)).toBe(
      "Zero is working, but its current step is not available yet. Your prompts are saved for the next safe pause.",
    );
    expect(promptQueueLandingMessage(41, ZERO_PROMPT_QUEUE_UNKNOWN_PHASE)).toBe(
      "Zero is working in a step this screen does not recognize yet. Your prompts are saved for the next safe pause.",
    );
  });

  it("sorts queued items and tells what happened to terminal records", async () => {
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
    const history = screen.getByRole("list", { name: "Prompt history" });
    expect(within(history).getByText("Removed")).toBeInTheDocument();
    expect(within(history).getByText(/Removed by you/)).toBeInTheDocument();
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
      "Only the first 50 queued prompts are shown.",
    );
  });

  it("does not claim queued prompts are hidden when only terminal records were truncated", async () => {
    mockedAuthFetch.mockResolvedValue(
      response(
        queuePayload(
          [
            { id: "queued", position: 1, currentText: "Still queued" },
            { id: "promoted", position: 2, currentText: "Already used", state: "promoted" },
          ],
          true,
        ),
      ),
    );

    render(
      <ZeroPromptQueueDrawer projectId={7} activeTaskId={null} phase={null} onClose={() => {}} />,
    );

    expect(await screen.findByText("Still queued")).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "Prompt history" })).toHaveTextContent("Already used");
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("refreshes on a streamed safe-boundary receipt after a prompt is promoted", async () => {
    mockedAuthFetch
      .mockResolvedValueOnce(
        response(queuePayload([{ id: "next", position: 1, currentText: "Add a flag" }])),
      )
      .mockResolvedValueOnce(
        response(
          queuePayload([{ id: "next", position: 1, currentText: "Add a flag", state: "promoted" }]),
        ),
      );

    const view = render(
      <ZeroPromptQueueDrawer
        projectId={7}
        activeTaskId={41}
        phase="createChatCompletion"
        onClose={() => {}}
      />,
    );
    expect(await screen.findByText("Add a flag")).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "Prompt order" })).toBeInTheDocument();

    view.rerender(
      <ZeroPromptQueueDrawer
        projectId={7}
        activeTaskId={41}
        phase="between_steps"
        onClose={() => {}}
      />,
    );

    await waitFor(() => expect(mockedAuthFetch).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(screen.queryByRole("list", { name: "Prompt order" })).not.toBeInTheDocument(),
    );
    expect(screen.getByRole("list", { name: "Prompt history" })).toHaveTextContent("Add a flag");
    expect(screen.getByText(/Used by Zero/)).toBeInTheDocument();
  });

  it("keeps the last good queue when an event-driven refresh fails", async () => {
    mockedAuthFetch
      .mockResolvedValueOnce(
        response(queuePayload([{ id: "next", position: 1, currentText: "Keep this" }])),
      )
      .mockRejectedValueOnce(new Error("raw transport detail"));

    const view = render(
      <ZeroPromptQueueDrawer
        projectId={7}
        activeTaskId={41}
        phase="serial_tool_call"
        onClose={() => {}}
      />,
    );
    expect(await screen.findByText("Keep this")).toBeInTheDocument();

    view.rerender(
      <ZeroPromptQueueDrawer
        projectId={7}
        activeTaskId={41}
        phase="between_steps"
        onClose={() => {}}
      />,
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The queued prompts could not be updated. Please try again.",
    );
    expect(screen.getByText("Keep this")).toBeInTheDocument();
    expect(screen.queryByText(/raw transport detail/i)).not.toBeInTheDocument();
  });

  it("bounds terminal history and never renders internal evidence identifiers", async () => {
    const terminalItems = Array.from({ length: 12 }, (_, index) => ({
      id: `terminal-${index + 1}`,
      position: index + 1,
      currentText: `Finished prompt ${index + 1}`,
      state: index % 2 === 0 ? "promoted" : "deleted",
      terminalEvidence:
        index % 2 === 0
          ? {
              kind: "promoted",
              activeTurnId: `private-turn-${index + 1}`,
              provenanceEventId: `private-event-${index + 1}`,
              occurredAt: `2026-08-20T17:${String(index).padStart(2, "0")}:00.000Z`,
            }
          : {
              kind: "deleted",
              deletedBy: `private-user-${index + 1}`,
              provenanceEventId: `private-event-${index + 1}`,
              occurredAt: `2026-08-20T17:${String(index).padStart(2, "0")}:00.000Z`,
            },
    }));
    mockedAuthFetch.mockResolvedValue(response(queuePayload(terminalItems)));

    const view = render(
      <ZeroPromptQueueDrawer projectId={7} activeTaskId={null} phase={null} onClose={() => {}} />,
    );

    const history = await screen.findByRole("list", { name: "Prompt history" });
    expect(within(history).getAllByRole("listitem")).toHaveLength(10);
    expect(history.querySelectorAll("time[datetime]")).toHaveLength(10);
    expect(screen.getByRole("status")).toHaveTextContent(
      "Only the first 10 prompt history entries are shown.",
    );
    expect(view.container).not.toHaveTextContent(
      /private-turn|private-event|private-user|queue\.item|promoted|deleted/i,
    );
  });

  it("uses deterministic relative time without a timezone acronym", async () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-08-20T17:02:30.000Z"));
    mockedAuthFetch.mockResolvedValue(
      response(
        queuePayload([
          {
            id: "fresh",
            position: 1,
            currentText: "Fresh prompt",
            state: "promoted",
            terminalEvidence: {
              kind: "promoted",
              activeTurnId: "turn-fresh",
              provenanceEventId: "event-fresh",
              occurredAt: "2026-08-20T17:02:15.000Z",
            },
          },
          {
            id: "minutes",
            position: 2,
            currentText: "Earlier prompt",
            state: "promoted",
            terminalEvidence: {
              kind: "promoted",
              activeTurnId: "turn-minutes",
              provenanceEventId: "event-minutes",
              occurredAt: "2026-08-20T17:00:30.000Z",
            },
          },
          {
            id: "yesterday",
            position: 3,
            currentText: "Yesterday prompt",
            state: "deleted",
            terminalEvidence: {
              kind: "deleted",
              deletedBy: "owner-7",
              provenanceEventId: "event-yesterday",
              occurredAt: "2026-08-19T16:02:30.000Z",
            },
          },
        ]),
      ),
    );

    const view = render(
      <ZeroPromptQueueDrawer projectId={7} activeTaskId={null} phase={null} onClose={() => {}} />,
    );

    const history = await screen.findByRole("list", { name: "Prompt history" });
    expect(within(history).getByText("just now")).toBeInTheDocument();
    expect(within(history).getByText("2 minutes ago")).toBeInTheDocument();
    expect(within(history).getByText("yesterday")).toBeInTheDocument();
    expect(view.container).not.toHaveTextContent(/UTC/i);
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
      history: [],
      truncated: false,
      historyTruncated: false,
    });
  });
});
