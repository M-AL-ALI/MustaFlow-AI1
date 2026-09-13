import { parseZeroTerminalV1, ZERO_TERMINAL_UNKNOWN } from "@workspace/ora-contracts";

type StoppableTaskReceipt = {
  id: number;
  projectId: number;
  status: string;
  intentReceiptId: number | null;
  terminal: unknown;
};

/** A replay is successful only for this task's durable, canonical user Stop. */
export function hasConfirmedUserStop(
  task: StoppableTaskReceipt | null | undefined,
  expected: { projectId: number; taskId: number },
): boolean {
  if (
    !task ||
    task.id !== expected.taskId ||
    task.projectId !== expected.projectId ||
    task.status !== "canceled" ||
    !Number.isSafeInteger(task.intentReceiptId) ||
    (task.intentReceiptId ?? 0) < 1
  ) {
    return false;
  }
  const terminal = parseZeroTerminalV1(task.terminal);
  return (
    terminal !== ZERO_TERMINAL_UNKNOWN &&
    terminal.outcome === "interrupted" &&
    terminal.cause === "user_stop" &&
    terminal.taskId === task.id &&
    terminal.intentReceiptId === task.intentReceiptId
  );
}
