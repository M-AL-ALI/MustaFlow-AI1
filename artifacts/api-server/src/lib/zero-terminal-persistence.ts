import { and, eq, inArray } from "drizzle-orm";
import { agentTasksTable, db, taskEventsTable } from "@workspace/db";
import {
  failedTerminal,
  interruptedTerminal,
  presentZeroTerminalV1,
  ZERO_TERMINAL_SEMANTICS,
  type FailedTerminal,
  type InterruptedTerminal,
  type ZeroIntent,
  type ZeroTerminalV1,
} from "@workspace/ora-contracts";
import { publishTaskEvent } from "./event-bus";

export type ZeroTerminalRef = {
  kind: "zero_terminal";
  schema: typeof ZERO_TERMINAL_SEMANTICS;
  taskId: number;
};

export function zeroTerminalRef(terminal: ZeroTerminalV1): ZeroTerminalRef {
  return {
    kind: "zero_terminal",
    schema: ZERO_TERMINAL_SEMANTICS,
    taskId: terminal.taskId,
  };
}

type AgentTaskUpdate = Partial<typeof agentTasksTable.$inferInsert>;

/**
 * Commit one canonical terminal to the task row and its terminal event in the
 * same transaction. Callers may project it into chat or notifications only
 * after this receipt exists; those projections carry zeroTerminalRef().
 */
export async function persistZeroTerminal(input: {
  terminal: ZeroTerminalV1;
  allowedStatuses?: string[];
  taskUpdate?: AgentTaskUpdate;
}): Promise<boolean> {
  const presentation = presentZeroTerminalV1(input.terminal);
  const completedAt = new Date(input.terminal.completedAt);
  const eventType =
    input.terminal.outcome === "interrupted"
      ? "cancelled"
      : input.terminal.outcome === "failed"
        ? "failed"
        : "completed";
  const taskStatus = presentation.taskStatus === "canceled" ? "canceled" : presentation.taskStatus;
  const terminalJson = input.terminal as unknown as Record<string, unknown>;

  const event = await db.transaction(async (tx) => {
    const [existingTerminal] = await tx
      .select({ id: taskEventsTable.id })
      .from(taskEventsTable)
      .where(
        and(
          eq(taskEventsTable.taskId, input.terminal.taskId),
          inArray(taskEventsTable.eventType, ["completed", "failed", "cancelled"]),
        ),
      )
      .limit(1);
    if (existingTerminal) return null;

    const predicate = input.allowedStatuses?.length
      ? and(
          eq(agentTasksTable.id, input.terminal.taskId),
          inArray(agentTasksTable.status, input.allowedStatuses),
        )
      : eq(agentTasksTable.id, input.terminal.taskId);
    const [task] = await tx
      .update(agentTasksTable)
      .set({
        ...input.taskUpdate,
        status: taskStatus,
        terminal: input.terminal,
        result: presentation.message,
        completedAt,
      })
      .where(predicate)
      .returning({ id: agentTasksTable.id });
    if (!task) return null;

    const [terminalEvent] = await tx
      .insert(taskEventsTable)
      .values({
        taskId: input.terminal.taskId,
        eventType,
        message: presentation.message,
        filePath: null,
        data: terminalJson,
        createdAt: completedAt,
      })
      .returning();
    return terminalEvent ?? null;
  });

  if (!event) return false;
  publishTaskEvent({
    id: event.id,
    taskId: event.taskId,
    eventType: event.eventType,
    message: event.message,
    filePath: event.filePath ?? null,
    data: (event.data as Record<string, unknown> | undefined) ?? undefined,
    createdAt: event.createdAt,
  });
  return true;
}

type TerminalCommonInput = {
  taskId: number;
  intent: ZeroIntent;
  intentReceiptId: number;
  completedAt?: string;
  allowedStatuses?: string[];
  taskUpdate?: AgentTaskUpdate;
};

/** Shared failure writer: construct once, then atomically persist task + event. */
export async function persistFailedZeroTerminal(
  input: TerminalCommonInput & {
    cause: FailedTerminal["cause"];
    summary: string;
  },
): Promise<{ terminal: FailedTerminal; persisted: boolean }> {
  const terminal = failedTerminal({
    schema: ZERO_TERMINAL_SEMANTICS,
    taskId: input.taskId,
    intent: input.intent,
    intentReceiptId: input.intentReceiptId,
    completedAt: input.completedAt ?? new Date().toISOString(),
    outcome: "failed",
    runStatus: "failed",
    cause: input.cause,
    evidence: { summary: input.summary },
  });
  const persisted = await persistZeroTerminal({
    terminal,
    allowedStatuses: input.allowedStatuses,
    taskUpdate: input.taskUpdate,
  });
  return { terminal, persisted };
}

/** Shared interruption writer: construct once, then atomically persist task + event. */
export async function persistInterruptedZeroTerminal(
  input: TerminalCommonInput & {
    cause: InterruptedTerminal["cause"];
    evidence: InterruptedTerminal["evidence"];
  },
): Promise<{ terminal: InterruptedTerminal; persisted: boolean }> {
  const terminal = interruptedTerminal({
    schema: ZERO_TERMINAL_SEMANTICS,
    taskId: input.taskId,
    intent: input.intent,
    intentReceiptId: input.intentReceiptId,
    completedAt: input.completedAt ?? new Date().toISOString(),
    outcome: "interrupted",
    runStatus: "interrupted",
    cause: input.cause,
    evidence: input.evidence,
  });
  const persisted = await persistZeroTerminal({
    terminal,
    allowedStatuses: input.allowedStatuses,
    taskUpdate: input.taskUpdate,
  });
  return { terminal, persisted };
}
