/**
 * In-memory store for mid-run steering hints submitted by the user while a
 * build task is in progress. The agent loop polls this store between steps.
 * Using an in-memory Map is intentional — hints are ephemeral (consumed once
 * by the next step) and never need to survive a restart.
 */

const store = new Map<number, string>();

export function setSteeringHint(taskId: number, hint: string): void {
  store.set(taskId, hint.trim().slice(0, 2000));
}

export function consumeSteeringHint(taskId: number): string | null {
  const hint = store.get(taskId) ?? null;
  if (hint !== null) store.delete(taskId);
  return hint;
}
