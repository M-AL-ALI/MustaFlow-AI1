/**
 * Minimal 5-field cron evaluator (Task #543).
 *
 * Supports the subset that the deployment scheduler needs:
 *   - "*"                  — any value
 *   - "N"                  — exact value
 *   - "*\/N" (star-slash-N)— every N steps
 *   - "A,B,C"              — comma list
 *   - "A-B"                — inclusive range
 *
 * Field order: minute hour day-of-month month day-of-week
 * Day-of-week: 0 = Sunday … 6 = Saturday.
 *
 * Designed to be small + dependency-free. Not a full cron implementation —
 * deliberately rejects unsupported tokens with a clear Error so the UI can
 * surface a validation message.
 */

export interface ParsedCron {
  minute: Set<number>;
  hour: Set<number>;
  dom: Set<number>;
  month: Set<number>;
  dow: Set<number>;
}

function parseField(spec: string, min: number, max: number): Set<number> {
  const out = new Set<number>();
  for (const part of spec.split(",")) {
    if (part === "*") {
      for (let i = min; i <= max; i++) out.add(i);
      continue;
    }
    const stepMatch = part.match(/^\*\/(\d+)$/);
    if (stepMatch) {
      const step = Number(stepMatch[1]);
      if (!Number.isFinite(step) || step <= 0) throw new Error(`bad step: ${part}`);
      for (let i = min; i <= max; i += step) out.add(i);
      continue;
    }
    const rangeMatch = part.match(/^(\d+)-(\d+)(?:\/(\d+))?$/);
    if (rangeMatch) {
      const a = Number(rangeMatch[1]);
      const b = Number(rangeMatch[2]);
      const step = rangeMatch[3] ? Number(rangeMatch[3]) : 1;
      if (a < min || b > max || a > b || step <= 0) throw new Error(`bad range: ${part}`);
      for (let i = a; i <= b; i += step) out.add(i);
      continue;
    }
    const num = Number(part);
    if (!Number.isFinite(num) || num < min || num > max) throw new Error(`bad field: ${part}`);
    out.add(num);
  }
  return out;
}

export function parseCron(expr: string): ParsedCron {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new Error(`cron expression must have 5 fields, got ${fields.length}`);
  }
  return {
    minute: parseField(fields[0]!, 0, 59),
    hour: parseField(fields[1]!, 0, 23),
    dom: parseField(fields[2]!, 1, 31),
    month: parseField(fields[3]!, 1, 12),
    dow: parseField(fields[4]!, 0, 6),
  };
}

/** Returns true when the given Date matches the cron expression (minute-grain). */
export function cronMatches(cron: ParsedCron, when: Date): boolean {
  return (
    cron.minute.has(when.getUTCMinutes()) &&
    cron.hour.has(when.getUTCHours()) &&
    cron.dom.has(when.getUTCDate()) &&
    cron.month.has(when.getUTCMonth() + 1) &&
    cron.dow.has(when.getUTCDay())
  );
}

/** Compute the next matching tick after `from` (UTC), looking ahead at most 366 days. */
export function nextCronTick(cron: ParsedCron, from: Date): Date | null {
  // Round up to the next minute boundary so we never re-fire the current minute.
  const start = new Date(from.getTime() + 60_000);
  start.setUTCSeconds(0, 0);
  const deadline = start.getTime() + 366 * 24 * 60 * 60_000;
  for (let t = start.getTime(); t < deadline; t += 60_000) {
    const d = new Date(t);
    if (cronMatches(cron, d)) return d;
  }
  return null;
}
