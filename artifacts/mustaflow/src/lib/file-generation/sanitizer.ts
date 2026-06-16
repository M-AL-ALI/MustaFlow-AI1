import { LIMITS } from "./size-limits";

const BANNED_EXACT = new Set([
  "fileRef",
  "imageRef",
  "datasetRef",
  "editedFrom",
  "hadAttachment",
  "suggestions",
]);

const BANNED_SUBSTRINGS = [
  "secret",
  "apikey",
  "authtoken",
  "sessiontoken",
  "handofftoken",
  "projectid",
  "builderid",
  "containerid",
  "neonproject",
  "flymachine",
];

function isBannedKey(key: string): boolean {
  if (BANNED_EXACT.has(key)) return true;
  const lower = key.toLowerCase();
  return BANNED_SUBSTRINGS.some((s) => lower.includes(s));
}

function isBase64Like(val: string): boolean {
  return val.length > 500 && /^[A-Za-z0-9+/=]+$/.test(val);
}

export function sanitizeValue(val: unknown): unknown {
  if (val === null || val === undefined) return val;
  if (typeof val === "string") {
    if (isBase64Like(val)) return "[REDACTED:binary]";
    return val;
  }
  if (typeof val === "number" || typeof val === "boolean") return val;
  if (Array.isArray(val)) return val.map(sanitizeValue);
  if (typeof val === "object") {
    return sanitizeObject(val as Record<string, unknown>);
  }
  return val;
}

function sanitizeObject(obj: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(obj)) {
    if (isBannedKey(key)) continue;
    result[key] = sanitizeValue(val);
  }
  return result;
}

export function sanitizeForExport<T extends object>(data: T): T {
  return sanitizeValue(data) as T;
}

export function truncateString(val: string, max: number): string {
  if (val.length <= max) return val;
  return val.slice(0, max) + "\u2026";
}

export function truncateArray<T>(arr: T[], max: number): T[] {
  return arr.length <= max ? arr : arr.slice(0, max);
}

function stripControlChars(val: string): string {
  return Array.from(val)
    .map((ch) => ((ch.codePointAt(0) ?? 32) < 32 ? " " : ch))
    .join("");
}

export function sanitizeTitle(title: string): string {
  return truncateString(stripControlChars(title).trim(), LIMITS.titleMaxChars);
}

export function sanitizeSummary(summary: string): string {
  return truncateString(stripControlChars(summary).trim(), LIMITS.summaryMaxChars);
}
