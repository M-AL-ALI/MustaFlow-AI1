export type ThreadDensity = "minimal" | "standard" | "detailed";

export function threadDensityForMode(mode: string | undefined): ThreadDensity {
  if (mode === "lite") return "minimal";
  if (mode === "pro") return "detailed";
  return "standard";
}

const DENSITY_ROW_LIMIT: Record<ThreadDensity, number> = {
  minimal: 1,
  standard: 6,
  detailed: 12,
};

export function visibleThreadEntries<T>(entries: T[], density: ThreadDensity): T[] {
  return entries.slice(-DENSITY_ROW_LIMIT[density]);
}
