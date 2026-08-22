import {
  presentZeroTerminalV1,
  presentPersistedZeroTerminal,
  ZERO_TERMINAL_UNKNOWN,
  type ZeroTerminalPresentation,
} from "@workspace/ora-contracts";

export type ZeroTerminalCarrier = {
  terminal?: unknown;
  status?: string | null;
  eventType?: string | null;
};

const LEGACY_TERMINAL_STATUSES = new Set([
  "completed",
  "failed",
  "canceled",
  "cancelled",
  "discarded",
]);

export function terminalPresentationFor(
  carrier: ZeroTerminalCarrier,
  terminalStatusHint?: string,
): ZeroTerminalPresentation | null {
  const persisted = presentPersistedZeroTerminal(carrier.terminal);
  if (persisted) return persisted;

  const status = carrier.status ?? carrier.eventType ?? terminalStatusHint;
  return status && LEGACY_TERMINAL_STATUSES.has(status)
    ? presentZeroTerminalV1(ZERO_TERMINAL_UNKNOWN)
    : null;
}

/** Prefer durable terminal truth while retaining legacy lifecycle state for old rows. */
export function terminalTaskStatus(carrier: ZeroTerminalCarrier, legacyStatus: string): string {
  return presentPersistedZeroTerminal(carrier.terminal)?.taskStatus ?? legacyStatus;
}

/** Terminal copy never falls back to unsupported legacy success prose. */
export function terminalTaskMessage(carrier: ZeroTerminalCarrier, legacyMessage: string): string {
  return terminalPresentationFor(carrier)?.message ?? legacyMessage;
}
