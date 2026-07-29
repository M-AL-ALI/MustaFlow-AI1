const RECENT_FILES_KEY = "mf_recent_files";
const MAX_RECENT = 8;

export function getRecentFiles(): number[] {
  try {
    return JSON.parse(localStorage.getItem(RECENT_FILES_KEY) ?? "[]") as number[];
  } catch {
    return [];
  }
}

export function pushRecentFile(fileId: number): void {
  try {
    const current = getRecentFiles();
    const next = [fileId, ...current.filter((id) => id !== fileId)].slice(0, MAX_RECENT);
    localStorage.setItem(RECENT_FILES_KEY, JSON.stringify(next));
  } catch {
    // Local history is a convenience; storage failures must not block navigation.
  }
}
