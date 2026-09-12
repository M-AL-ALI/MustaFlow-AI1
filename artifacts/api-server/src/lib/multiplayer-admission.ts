/** Same decimal int4 domain as REST project access, including leading zeroes. */
export function parseMultiplayerProjectId(value: unknown): number | null {
  if (typeof value !== "string" || !/^[0-9]+$/.test(value)) return null;
  const projectId = Number(value);
  return Number.isInteger(projectId) && projectId >= 1 && projectId <= 2147483647
    ? projectId
    : null;
}

/** EventEmitter ignores listener promises: own both admission and failure here. */
export async function runMultiplayerAdmission(
  admit: () => Promise<void>,
  onFailure: () => void | Promise<void>,
): Promise<void> {
  try {
    await admit();
  } catch {
    try {
      await onFailure();
    } catch {
      // This is the terminal rejection sink. Cleanup/transport failures must not
      // create another unhandled rejection after the admission already failed.
    }
  }
}
