import { createHash } from "node:crypto";

// JSONB does not preserve object-key order. A browser revision must survive the
// database round trip, and represent the whole stored map, not a sanitized view.
function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, child]) => [key, canonicalJson(child)]),
    );
  }
  return value;
}
export function pageMapRevision(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalJson(value ?? null)))
    .digest("hex");
}
