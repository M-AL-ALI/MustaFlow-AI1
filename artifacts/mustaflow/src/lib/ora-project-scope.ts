/**
 * Pure helpers for the Ora Projects conversation-scoping flow.
 *
 * These encode the decisions that make project-scoped chats behave like
 * ChatGPT Projects, kept dependency-free so they can be unit-tested without
 * Clerk/fetch/React. The provider (`use-ora-conversations.tsx`) is the only
 * consumer.
 */

/**
 * Resolve the `projectId` a brand-new conversation should be created with.
 *
 * `explicit` is the per-new-conversation override:
 *   - `undefined` → no override; fall back to the active project (route).
 *   - `null`      → an explicit standalone chat (`projectId = null`).
 *   - a number    → that specific project.
 *
 * The active project comes from the `/ora/projects/:projectId` route, so a
 * fresh chat opened while inside a project is scoped to it even when the
 * `sessionStorage` handoff is absent (e.g. a hard reload on the project route).
 */
export function resolveScopeProjectId(
  explicit: number | null | undefined,
  activeProjectId: number | null,
): number | null {
  if (explicit === undefined) return activeProjectId ?? null;
  return explicit;
}

/**
 * After moving a conversation into `destProjectId`, decide whether the
 * currently-open conversation must be deselected so the UI never shows a chat
 * inside the wrong project. We deselect only when the conversation that moved is
 * the one currently open AND its new home is not the active project.
 */
export function shouldDeselectMovedConversation(
  movedId: number,
  currentId: number | null,
  destProjectId: number | null,
  activeProjectId: number | null,
): boolean {
  if (currentId !== movedId) return false;
  return destProjectId !== activeProjectId;
}

/**
 * Whether `activeProjectId` points at a project that still exists (is loaded and
 * not archived/deleted). Used to decide if the route should redirect to `/ora`.
 * Returns `true` when there is no active project (nothing to validate).
 */
export function isActiveProjectValid(
  activeProjectId: number | null,
  projects: { id: number }[],
): boolean {
  if (activeProjectId == null) return true;
  return projects.some((p) => p.id === activeProjectId);
}
