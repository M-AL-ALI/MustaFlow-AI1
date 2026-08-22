import {
  presentPersistedZeroTerminal,
  type ZeroTerminalPresentation,
} from "@workspace/ora-contracts";

export type ZeroTerminalCarrier = { terminal?: unknown };

export function terminalPresentationFor(
  carrier: ZeroTerminalCarrier,
): ZeroTerminalPresentation | null {
  return presentPersistedZeroTerminal(carrier.terminal);
}

/** Prefer durable terminal truth; null preserves the caller's legacy status exactly. */
export function terminalTaskStatus(carrier: ZeroTerminalCarrier, legacyStatus: string): string {
  return terminalPresentationFor(carrier)?.taskStatus ?? legacyStatus;
}

/**
 * @dormantExport
 * B3b consumes this canonical message helper when durable terminal writers are wired.
 */
export function terminalTaskMessage(carrier: ZeroTerminalCarrier, legacyMessage: string): string {
  return terminalPresentationFor(carrier)?.message ?? legacyMessage;
}
