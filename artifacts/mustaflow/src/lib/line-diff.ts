export type DiffLine =
  | { type: "context"; text: string; oldLine: number; newLine: number }
  | { type: "add"; text: string; newLine: number }
  | { type: "del"; text: string; oldLine: number };

export interface DiffHunk {
  oldStart: number;
  newStart: number;
  lines: DiffLine[];
}

function lcs(a: string[], b: string[]): number[][] {
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      if (a[i] === b[j]) dp[i][j] = dp[i + 1][j + 1] + 1;
      else dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  return dp;
}

function diffLines(a: string[], b: string[]): DiffLine[] {
  const dp = lcs(a, b);
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  let oldLine = 1;
  let newLine = 1;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ type: "context", text: a[i], oldLine, newLine });
      i++;
      j++;
      oldLine++;
      newLine++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ type: "del", text: a[i], oldLine });
      i++;
      oldLine++;
    } else {
      out.push({ type: "add", text: b[j], newLine });
      j++;
      newLine++;
    }
  }
  while (i < a.length) {
    out.push({ type: "del", text: a[i], oldLine });
    i++;
    oldLine++;
  }
  while (j < b.length) {
    out.push({ type: "add", text: b[j], newLine });
    j++;
    newLine++;
  }
  return out;
}

export function unifiedDiff(before: string, after: string, contextLines = 3): DiffHunk[] {
  const a = before.split("\n");
  const b = after.split("\n");
  const lines = diffLines(a, b);

  const hunks: DiffHunk[] = [];
  let i = 0;
  while (i < lines.length) {
    if (lines[i].type === "context") {
      i++;
      continue;
    }
    const start = Math.max(0, i - contextLines);
    let end = i;
    while (end < lines.length) {
      if (lines[end].type !== "context") {
        end++;
        continue;
      }
      let lookahead = 0;
      let k = end;
      while (k < lines.length && lines[k].type === "context") {
        lookahead++;
        k++;
      }
      if (k >= lines.length || lookahead >= contextLines * 2) {
        end = Math.min(end + contextLines, lines.length);
        break;
      }
      end = k;
    }

    const slice = lines.slice(start, end);
    const firstOld = slice.find((l) => l.type !== "add");
    const firstNew = slice.find((l) => l.type !== "del");
    hunks.push({
      oldStart: firstOld ? ("oldLine" in firstOld ? firstOld.oldLine : 1) : 1,
      newStart: firstNew ? ("newLine" in firstNew ? firstNew.newLine : 1) : 1,
      lines: slice,
    });
    i = end;
  }
  return hunks;
}

export function countChangedLines(
  before: string,
  after: string,
): {
  added: number;
  removed: number;
} {
  const a = before.split("\n");
  const b = after.split("\n");
  const lines = diffLines(a, b);
  let added = 0;
  let removed = 0;
  for (const l of lines) {
    if (l.type === "add") added++;
    else if (l.type === "del") removed++;
  }
  return { added, removed };
}
