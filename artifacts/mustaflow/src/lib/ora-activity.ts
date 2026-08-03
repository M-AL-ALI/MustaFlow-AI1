/**
 * Ora live activity trace — client-side state model (website).
 *
 * A tiny pure reducer over the shared `OraActivityStep` shape from
 * @workspace/ora-contracts. The trace is a LIVING line, not a growing log:
 * only the current step is prominent; when a new step starts the previous one
 * fades out and is dropped, and a terminal ok/fail updates the current step in
 * place. The whole trace clears on the first real answer token.
 *
 * Kept free of React so the reducer is unit-testable (registered in the Ora
 * stability gate) and shareable across components.
 */
import type { OraActivityStep } from "@workspace/ora-contracts";

/** A trace step with a client-assigned identity for keyed fade animations. */
export interface OraActivityTraceStep extends OraActivityStep {
  id: number;
}

/** How many steps the trace retains (current + a short fading tail). */
export const ORA_ACTIVITY_TRACE_LIMIT = 3;

let nextTraceId = 1;

/** Test hook: reset the id counter so snapshots are deterministic. */
export function resetOraActivityIds(): void {
  nextTraceId = 1;
}

/**
 * Fold one incoming activity step into the trace.
 *
 * - `start` appends a NEW current step (the previous current begins fading).
 * - `ok`/`fail` for the tool of the current `start` step updates it IN PLACE
 *   (same id — the row crossfades text instead of re-entering).
 * - a terminal with no matching in-progress step is appended as its own step
 *   (covers server-synthesized terminals on the non-streaming tool paths).
 *
 * The returned list is bounded to ORA_ACTIVITY_TRACE_LIMIT entries, newest
 * last. Input list is never mutated.
 */
export function reduceOraActivity(
  steps: OraActivityTraceStep[],
  incoming: OraActivityStep,
): OraActivityTraceStep[] {
  if (incoming.phase !== "start") {
    const current = steps[steps.length - 1];
    if (current && current.tool === incoming.tool && current.phase === "start") {
      return [...steps.slice(0, -1), { ...current, phase: incoming.phase, text: incoming.text }];
    }
  }
  const next = [...steps, { ...incoming, id: nextTraceId++ }];
  return next.slice(-ORA_ACTIVITY_TRACE_LIMIT);
}

/** The empty trace (used to clear on first token / turn end / errors). */
export function clearedOraActivity(): OraActivityTraceStep[] {
  return [];
}

/** The step the UI should render prominently right now (newest), or null. */
export function currentOraActivityStep(steps: OraActivityTraceStep[]): OraActivityTraceStep | null {
  return steps[steps.length - 1] ?? null;
}
