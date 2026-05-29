/**
 * Server-side dataset statistics for Ora Phase 3.
 *
 * Computes column profiles (type detection, null counts, numeric stats,
 * top categories, date ranges) and Pareto pre-computations from the full
 * parsed dataset (up to the 10,000-row cap).
 *
 * Nothing is logged in this module.
 */

export interface ColumnProfile {
  index: number;
  type: "numeric" | "string" | "date" | "boolean" | "empty";
  nullCount: number;
  uniqueCount: number;
  min?: number;
  max?: number;
  mean?: number;
  sum?: number;
  stddev?: number;
  topCategories?: Array<{ value: string; count: number }>;
  minDate?: string;
  maxDate?: string;
}

export interface ParetoEntry {
  label: string;
  value: number;
  cumPct: number;
}

export interface ParetoSet {
  categoryColIndex: number;
  valueColIndex: number;
  entries: ParetoEntry[];
}

const DATE_RE =
  /^(\d{4}[-/]\d{2}[-/]\d{2}(T\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:\d{2})?)?|\d{1,2}[-/]\d{1,2}[-/]\d{4})$/;

const BOOL_VALUES = new Set(["true", "false", "yes", "no", "1", "0", "y", "n"]);

function parseNumericStr(v: string): number {
  return parseFloat(v.replace(/,/g, ""));
}

function detectColumnType(
  nonEmpty: string[],
): "numeric" | "string" | "date" | "boolean" | "empty" {
  if (nonEmpty.length === 0) return "empty";
  if (nonEmpty.every((v) => BOOL_VALUES.has(v.toLowerCase().trim()))) return "boolean";
  if (
    nonEmpty.every((v) => {
      const t = v.trim();
      return t !== "" && /^-?[\d,]+\.?\d*$/.test(t);
    })
  )
    return "numeric";
  if (nonEmpty.every((v) => DATE_RE.test(v.trim()))) return "date";
  return "string";
}

export function computeColumnProfiles(headers: string[], rows: string[][]): ColumnProfile[] {
  const colCount = headers.length;
  const profiles: ColumnProfile[] = [];

  for (let ci = 0; ci < colCount; ci++) {
    const allValues = rows.map((r) => r[ci] ?? "");
    const nonEmpty = allValues.filter((v) => v !== "");
    const nullCount = allValues.length - nonEmpty.length;
    const uniqueSet = new Set(nonEmpty);
    const uniqueCount = uniqueSet.size;
    const type = detectColumnType(nonEmpty);

    const profile: ColumnProfile = { index: ci, type, nullCount, uniqueCount };

    if (type === "numeric" && nonEmpty.length > 0) {
      const nums = nonEmpty.map(parseNumericStr).filter((n) => !isNaN(n));
      if (nums.length > 0) {
        const sum = nums.reduce((a, b) => a + b, 0);
        const mean = sum / nums.length;
        const variance =
          nums.reduce((a, b) => a + (b - mean) ** 2, 0) / nums.length;
        profile.min = Math.min(...nums);
        profile.max = Math.max(...nums);
        profile.mean = Math.round(mean * 1e6) / 1e6;
        profile.sum = Math.round(sum * 1e6) / 1e6;
        profile.stddev = Math.round(Math.sqrt(variance) * 1e6) / 1e6;
      }
    } else if (type === "string" && nonEmpty.length > 0) {
      const freqMap = new Map<string, number>();
      for (const v of nonEmpty) {
        freqMap.set(v, (freqMap.get(v) ?? 0) + 1);
      }
      profile.topCategories = [...freqMap.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([value, count]) => ({ value, count }));
    } else if (type === "date" && nonEmpty.length > 0) {
      const sorted = [...nonEmpty].sort();
      profile.minDate = sorted[0];
      profile.maxDate = sorted[sorted.length - 1];
    }

    profiles.push(profile);
  }

  return profiles;
}

export function computePareto(
  _headers: string[],
  rows: string[][],
  profiles: ColumnProfile[],
): ParetoSet[] {
  const catCols = profiles.filter(
    (p) => p.type === "string" && p.uniqueCount >= 2 && p.uniqueCount <= 50,
  );
  const numCols = profiles.filter((p) => p.type === "numeric" && p.sum !== undefined);
  if (catCols.length === 0 || numCols.length === 0) return [];

  const sets: ParetoSet[] = [];

  for (const catCol of catCols.slice(0, 3)) {
    for (const numCol of numCols.slice(0, 2)) {
      if (sets.length >= 3) break;

      const groupSums = new Map<string, number>();
      for (const row of rows) {
        const catVal = (row[catCol.index] ?? "").trim();
        const numStr = (row[numCol.index] ?? "").trim();
        const numVal = parseNumericStr(numStr);
        if (catVal !== "" && !isNaN(numVal)) {
          groupSums.set(catVal, (groupSums.get(catVal) ?? 0) + numVal);
        }
      }

      const positiveEntries = [...groupSums.entries()].filter(([, v]) => v > 0);
      if (positiveEntries.length === 0) continue;

      const total = positiveEntries.reduce((a, [, v]) => a + v, 0);
      if (total === 0) continue;

      const sorted = positiveEntries.sort((a, b) => b[1] - a[1]).slice(0, 20);
      let cumSum = 0;
      const entries: ParetoEntry[] = sorted.map(([label, value]) => {
        cumSum += value;
        return {
          label,
          value,
          cumPct: Math.round((cumSum / total) * 1000) / 10,
        };
      });

      sets.push({ categoryColIndex: catCol.index, valueColIndex: numCol.index, entries });
    }
    if (sets.length >= 3) break;
  }

  return sets;
}
