export type OraxSandboxFile = {
  path: string;
  content: string;
  size: number;
  sha: string;
};

export type OraxSandboxChangedFile = {
  path: string;
  beforeBytes: number;
  afterBytes: number;
  additions: number;
  deletions: number;
};

export type OraxSandboxCheck = {
  name: string;
  status: "passed" | "failed" | "not_run";
  message: string;
};

export type OraxSandboxValidation = {
  mode: "in_memory_patch_sandbox";
  applied: boolean;
  changedFiles: OraxSandboxChangedFile[];
  checks: OraxSandboxCheck[];
  errors: string[];
  testPreview: OraxSandboxCheck[];
};

type ParsedPatch = {
  path: string;
  hunks: ParsedHunk[];
};

type ParsedHunk = {
  oldStart: number;
  lines: string[];
};

export function runOraxSandboxValidation(input: {
  unifiedDiff: string;
  files: OraxSandboxFile[];
  suggestedTests?: string[];
}): OraxSandboxValidation {
  const filesByPath = new Map(input.files.map((file) => [file.path, file]));
  const parsed = parseUnifiedDiff(input.unifiedDiff);
  const errors: string[] = [];
  const changedFiles: OraxSandboxChangedFile[] = [];
  const checks: OraxSandboxCheck[] = [];

  if (!parsed.length) {
    errors.push("No unified diff could be parsed.");
  }

  for (const patch of parsed) {
    const source = filesByPath.get(patch.path);
    if (!source) {
      errors.push(`Patch touches ${patch.path}, which is outside the approved file set.`);
      continue;
    }

    const result = applyPatchToContent(source.content, patch);
    if (!result.ok) {
      errors.push(`${patch.path}: ${result.error}`);
      continue;
    }

    changedFiles.push({
      path: patch.path,
      beforeBytes: Buffer.byteLength(source.content, "utf8"),
      afterBytes: Buffer.byteLength(result.content, "utf8"),
      additions: result.additions,
      deletions: result.deletions,
    });

    checks.push(...runStaticChecks(patch.path, result.content));
  }

  if (!changedFiles.length && parsed.length) {
    errors.push("The diff did not produce any changed approved files.");
  }

  const applied = errors.length === 0 && changedFiles.length > 0;
  return {
    mode: "in_memory_patch_sandbox",
    applied,
    changedFiles,
    checks,
    errors,
    testPreview: (input.suggestedTests ?? []).slice(0, 8).map((test) => ({
      name: test,
      status: "not_run",
      message:
        "External command execution remains locked in this phase. This check is listed for review.",
    })),
  };
}

export function parseUnifiedDiff(diff: string): ParsedPatch[] {
  const lines = diff.replace(/\r\n/g, "\n").split("\n");
  const patches: ParsedPatch[] = [];
  let current: ParsedPatch | null = null;
  let currentHunk: ParsedHunk | null = null;

  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      current = null;
      currentHunk = null;
      continue;
    }
    if (line.startsWith("+++ ")) {
      const path = normalizeDiffPath(line.slice(4).trim());
      if (!path || path === "/dev/null") {
        current = null;
        currentHunk = null;
        continue;
      }
      current = { path, hunks: [] };
      patches.push(current);
      continue;
    }
    if (line.startsWith("@@ ")) {
      if (!current) continue;
      const match = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (!match) continue;
      currentHunk = { oldStart: Number(match[1]), lines: [] };
      current.hunks.push(currentHunk);
      continue;
    }
    if (currentHunk && /^[ +\-\\]/.test(line)) {
      currentHunk.lines.push(line);
    }
  }

  return patches.filter((patch) => patch.hunks.length);
}

function applyPatchToContent(
  content: string,
  patch: ParsedPatch,
):
  | { ok: true; content: string; additions: number; deletions: number }
  | { ok: false; error: string } {
  const original = content.replace(/\r\n/g, "\n").split("\n");
  const output: string[] = [];
  let cursor = 0;
  let additions = 0;
  let deletions = 0;

  for (const hunk of patch.hunks) {
    const hunkStart = Math.max(hunk.oldStart - 1, 0);
    if (hunkStart < cursor) {
      return { ok: false, error: "Overlapping hunks are not supported." };
    }
    output.push(...original.slice(cursor, hunkStart));
    cursor = hunkStart;

    for (const line of hunk.lines) {
      if (line === "\\ No newline at end of file") continue;
      const marker = line[0];
      const value = line.slice(1);
      if (marker === " ") {
        if (original[cursor] !== value) {
          return {
            ok: false,
            error: `Context mismatch near line ${cursor + 1}.`,
          };
        }
        output.push(value);
        cursor += 1;
      } else if (marker === "-") {
        if (original[cursor] !== value) {
          return {
            ok: false,
            error: `Deletion mismatch near line ${cursor + 1}.`,
          };
        }
        cursor += 1;
        deletions += 1;
      } else if (marker === "+") {
        output.push(value);
        additions += 1;
      }
    }
  }

  output.push(...original.slice(cursor));
  return { ok: true, content: output.join("\n"), additions, deletions };
}

function runStaticChecks(path: string, content: string): OraxSandboxCheck[] {
  const checks: OraxSandboxCheck[] = [
    {
      name: `${path}: patch applies`,
      status: "passed",
      message: "The unified diff applied cleanly inside the isolated sandbox.",
    },
  ];

  if (path.toLowerCase().endsWith(".json")) {
    try {
      JSON.parse(content);
      checks.push({
        name: `${path}: JSON syntax`,
        status: "passed",
        message: "JSON parsed successfully after the patch.",
      });
    } catch (err) {
      checks.push({
        name: `${path}: JSON syntax`,
        status: "failed",
        message: err instanceof Error ? err.message : "JSON parse failed.",
      });
    }
  }

  return checks;
}

function normalizeDiffPath(path: string): string {
  if (path.startsWith("a/") || path.startsWith("b/")) return path.slice(2);
  return path;
}
