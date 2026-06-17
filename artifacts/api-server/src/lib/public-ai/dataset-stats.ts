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
  // IQR-based distribution + outlier fields (numeric columns with >= 8 values).
  q1?: number;
  median?: number;
  q3?: number;
  iqr?: number;
  lowerFence?: number;
  upperFence?: number;
  outlierCount?: number;
  lowOutlierCount?: number;
  highOutlierCount?: number;
  sampleOutliers?: number[];
  topCategories?: Array<{ value: string; count: number }>;
  minDate?: string;
  maxDate?: string;
}

/**
 * Dataset-level duplicate-row detection result. Rows are compared after
 * normalizing each cell (trim + collapse internal whitespace + lowercase) so
 * cosmetically-different copies of the same record still count as duplicates.
 */
export interface DuplicateRowStats {
  // Redundant copies: sum over repeated rows of (occurrences - 1).
  duplicateRowCount: number;
  // Number of distinct rows that occur more than once.
  duplicateGroupCount: number;
  // Up to a few example duplicated rows, with their occurrence count.
  sampleDuplicates: Array<{ count: number; preview: string }>;
}

// Minimum non-null numeric values before IQR/outlier stats are meaningful.
const MIN_OUTLIER_SAMPLE = 8;

const round6 = (n: number): number => Math.round(n * 1e6) / 1e6;

/**
 * Linear-interpolation quantile over an ascending-sorted numeric array.
 */
function quantileSorted(sorted: number[], q: number): number {
  if (sorted.length === 0) return NaN;
  if (sorted.length === 1) return sorted[0]!;
  const pos = (sorted.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  const lower = sorted[base]!;
  const upper = sorted[base + 1] ?? lower;
  return lower + rest * (upper - lower);
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

function detectColumnType(nonEmpty: string[]): "numeric" | "string" | "date" | "boolean" | "empty" {
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
        const variance = nums.reduce((a, b) => a + (b - mean) ** 2, 0) / nums.length;
        profile.min = Math.min(...nums);
        profile.max = Math.max(...nums);
        profile.mean = round6(mean);
        profile.sum = round6(sum);
        profile.stddev = round6(Math.sqrt(variance));

        // IQR-based outlier detection (Tukey fences). Robust and assumes no
        // particular distribution. Only meaningful with enough values.
        if (nums.length >= MIN_OUTLIER_SAMPLE) {
          const sorted = [...nums].sort((a, b) => a - b);
          const q1 = quantileSorted(sorted, 0.25);
          const median = quantileSorted(sorted, 0.5);
          const q3 = quantileSorted(sorted, 0.75);
          const iqr = q3 - q1;
          const lowerFence = q1 - 1.5 * iqr;
          const upperFence = q3 + 1.5 * iqr;
          const low = sorted.filter((n) => n < lowerFence);
          const high = sorted.filter((n) => n > upperFence);
          // Most extreme few outliers (lowest lows + highest highs).
          const sampleOutliers = [...low.slice(0, 3), ...high.slice(-3)].slice(0, 5).map(round6);

          profile.q1 = round6(q1);
          profile.median = round6(median);
          profile.q3 = round6(q3);
          profile.iqr = round6(iqr);
          profile.lowerFence = round6(lowerFence);
          profile.upperFence = round6(upperFence);
          profile.lowOutlierCount = low.length;
          profile.highOutlierCount = high.length;
          profile.outlierCount = low.length + high.length;
          if (sampleOutliers.length > 0) profile.sampleOutliers = sampleOutliers;
        }
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

const DUP_PREVIEW_MAX_CHARS = 120;

/**
 * Normalize a single cell for duplicate comparison: trim, collapse internal
 * whitespace runs, and lowercase. This makes "Acme  Inc" and "acme inc" equal.
 */
function normalizeCellForDup(cell: string): string {
  return cell.trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * Detect fully-duplicated rows across the dataset. Two rows are duplicates when
 * every cell matches after normalization. Rows that are entirely empty are
 * ignored so blank padding rows are not reported as duplicates.
 */
export function computeDuplicateRowStats(headers: string[], rows: string[][]): DuplicateRowStats {
  const colCount = headers.length;
  const counts = new Map<string, { count: number; first: string[] }>();

  for (const row of rows) {
    const cells: string[] = [];
    let allEmpty = true;
    for (let ci = 0; ci < colCount; ci++) {
      const norm = normalizeCellForDup(row[ci] ?? "");
      if (norm !== "") allEmpty = false;
      cells.push(norm);
    }
    if (allEmpty) continue;
    const key = cells.join("\u0001");
    const existing = counts.get(key);
    if (existing) {
      existing.count++;
    } else {
      counts.set(key, { count: 1, first: row.slice(0, colCount) });
    }
  }

  let duplicateRowCount = 0;
  let duplicateGroupCount = 0;
  const groups: Array<{ count: number; first: string[] }> = [];
  for (const entry of counts.values()) {
    if (entry.count > 1) {
      duplicateGroupCount++;
      duplicateRowCount += entry.count - 1;
      groups.push(entry);
    }
  }

  const sampleDuplicates = groups
    .sort((a, b) => b.count - a.count)
    .slice(0, 3)
    .map((g) => {
      let preview = g.first.map((c) => c.trim()).join(" | ");
      if (preview.length > DUP_PREVIEW_MAX_CHARS) {
        preview = preview.slice(0, DUP_PREVIEW_MAX_CHARS - 3) + "...";
      }
      return { count: g.count, preview };
    });

  return { duplicateRowCount, duplicateGroupCount, sampleDuplicates };
}
