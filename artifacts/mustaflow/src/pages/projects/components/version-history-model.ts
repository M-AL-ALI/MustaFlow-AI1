export interface VersionHistoryEntryCopy {
  label: string;
  note?: string | null;
  changelogEntry?: string | null;
  triggerMessagePreview?: string | null;
  filesCount: number;
}

interface ClockFormatOptions {
  locale?: string;
  timeZone?: string;
}

function firstMeaningful(values: Array<string | null | undefined>): string | null {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) return trimmed;
  }
  return null;
}

export function versionHistoryDescription(entry: VersionHistoryEntryCopy): string {
  return (
    firstMeaningful([entry.changelogEntry, entry.note, entry.triggerMessagePreview]) ??
    `${entry.filesCount} file${entry.filesCount === 1 ? "" : "s"} saved`
  );
}

export function formatCheckpointClockTime(iso: string, options: ClockFormatOptions = {}): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "that time";

  return new Intl.DateTimeFormat(options.locale, {
    hour: "numeric",
    minute: "2-digit",
    ...(options.timeZone ? { timeZone: options.timeZone } : {}),
  }).format(date);
}

export function restoreConfirmationMessage(iso: string, options: ClockFormatOptions = {}): string {
  return `Take your app back to how it was at ${formatCheckpointClockTime(
    iso,
    options,
  )}? Your current version stays saved.`;
}
