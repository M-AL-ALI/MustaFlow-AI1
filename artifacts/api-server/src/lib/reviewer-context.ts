export type ReviewerFile = {
  path: string;
  content: string;
};

type ReviewerWorkspace = {
  diff(): {
    changed: ReviewerFile[];
    removed: string[];
  };
  all?(): ReviewerFile[];
};

export type ReviewerWorkspaceContext = {
  diff: {
    filesAdded: string[];
    filesModified: string[];
    filesRemoved: string[];
  };
  fileExcerpts: ReviewerExcerpt[];
  missingRequestedPaths: string[];
};

export type ReviewerDiff = ReviewerWorkspaceContext["diff"];

const REVIEWER_MAX_FILE_EXCERPTS = 8;
const REVIEWER_MAX_TOTAL_EXCERPT_CHARS = 30_000;
const REVIEWER_TRUNCATION_MARKER = (originalChars: number, includedChars: number): string =>
  `\n\n[REVIEW CONTEXT TRUNCATED: showing ${includedChars} of ${originalChars} characters. This boundary is not the end of the file; do not infer missing closing syntax from it.]`;
const REVIEWABLE_PATH_PATTERN =
  /(?:^|[\s`"'(:,])((?:\.\/)?(?:[\w@.-]+\/)*[\w@.-]+\.(?:tsx?|jsx?|css|scss|sass|less|html?|vue|svelte|json|mdx?|py|rb|go|rs|java|kt|swift|php|cs))(?=$|[\s`"',.;:)\]])/gi;
const SOURCE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".css",
  ".scss",
  ".sass",
  ".less",
  ".html",
  ".htm",
  ".vue",
  ".svelte",
]);
const CONFIG_BASENAMES = new Set([
  ".gitignore",
  "package.json",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
  "tsconfig.json",
  "jsconfig.json",
  "vite.config.ts",
  "vite.config.js",
  "tailwind.config.ts",
  "tailwind.config.js",
  "postcss.config.js",
  "postcss.config.cjs",
  "eslint.config.js",
  "eslint.config.mjs",
]);
const ENTRY_BASENAMES = new Set(["app", "main", "index"]);

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();
}

export { normalizePath as normalizeReviewerPath };

function basename(path: string): string {
  return normalizePath(path).split("/").pop() ?? "";
}

function extension(path: string): string {
  const name = basename(path);
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? name.slice(dot) : "";
}

function basenameWithoutExtension(path: string): string {
  const name = basename(path);
  const dot = name.indexOf(".");
  return dot >= 0 ? name.slice(0, dot) : name;
}

function extractRequestedPaths(reviewRequest: string | undefined): string[] {
  if (!reviewRequest) return [];
  const requested: string[] = [];
  const seen = new Set<string>();
  for (const match of reviewRequest.matchAll(REVIEWABLE_PATH_PATTERN)) {
    const path = match[1]?.replace(/^\.\//, "");
    if (!path) continue;
    const normalized = normalizePath(path);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    requested.push(path);
  }
  return requested;
}

function isConfigOrLockfile(path: string): boolean {
  const name = basename(path);
  return (
    CONFIG_BASENAMES.has(name) ||
    name.endsWith(".lock") ||
    /^tsconfig(?:\.[\w-]+)?\.json$/.test(name) ||
    /^(?:vite|tailwind|postcss|eslint)\.config\.[\w]+$/.test(name)
  );
}

function sourcePriority(file: ReviewerFile): number {
  const path = normalizePath(file.path);
  if (isConfigOrLockfile(path)) return 3;
  if (path.startsWith("src/")) return 0;
  if (SOURCE_EXTENSIONS.has(extension(path))) return 1;
  return 2;
}

function compareReviewCandidates(a: ReviewerFile, b: ReviewerFile): number {
  const sourceDelta = sourcePriority(a) - sourcePriority(b);
  if (sourceDelta !== 0) return sourceDelta;

  const entryDelta =
    Number(!ENTRY_BASENAMES.has(basenameWithoutExtension(a.path))) -
    Number(!ENTRY_BASENAMES.has(basenameWithoutExtension(b.path)));
  if (entryDelta !== 0) return entryDelta;

  const sizeDelta = b.content.length - a.content.length;
  if (sizeDelta !== 0) return sizeDelta;
  return normalizePath(a.path).localeCompare(normalizePath(b.path));
}

export type ReviewerExcerpt = ReviewerFile & {
  truncated: boolean;
  originalChars: number;
};

type ReviewerExcerptInput = ReviewerFile & {
  truncated?: boolean;
  originalChars?: number;
};

/**
 * Keep requested/changed source ahead of supporting files. Within each group,
 * share the bounded space so a large first file cannot hide every later file.
 * The architect assembler uses the same limiter, rather than truncating again
 * with a different policy.
 */
export function boundReviewerFileExcerpts(
  files: ReviewerExcerptInput[],
  priorityPaths: string[] = files.map((file) => file.path),
): ReviewerExcerpt[] {
  const selected = files.slice(0, REVIEWER_MAX_FILE_EXCERPTS);
  const priority = new Set(priorityPaths.map(normalizePath));
  const groups = [
    selected.filter((file) => priority.has(normalizePath(file.path))),
    selected.filter((file) => !priority.has(normalizePath(file.path))),
  ];
  const bounded = new Map<ReviewerExcerptInput, ReviewerExcerpt>();
  let remainingChars = REVIEWER_MAX_TOTAL_EXCERPT_CHARS;
  for (const group of groups) {
    if (group.length === 0 || remainingChars <= 0) continue;
    // Water-fill: small files stay complete; large files share what remains.
    let low = 0;
    let high = remainingChars;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      const required = group.reduce(
        (total, file) => total + Math.min(file.content.length, middle),
        0,
      );
      if (required <= remainingChars) low = middle;
      else high = middle - 1;
    }
    const budgets = group.map((file) => Math.min(file.content.length, low));
    let spare = remainingChars - budgets.reduce((total, budget) => total + budget, 0);
    for (let index = 0; index < group.length && spare > 0; index++) {
      if (budgets[index] < group[index].content.length) {
        budgets[index]++;
        spare--;
      }
    }
    const appendExcerpt = (file: ReviewerExcerptInput, budget: number): void => {
      const originalChars = file.originalChars ?? file.content.length;
      let excerpt: ReviewerExcerpt;
      if (file.content.length <= budget) {
        excerpt = {
          path: file.path,
          content: file.content,
          truncated: file.truncated ?? false,
          originalChars,
        };
      } else {
        // Reserve enough room for the largest possible character-count label.
        const markerBudget = REVIEWER_TRUNCATION_MARKER(originalChars, file.content.length).length;
        if (budget <= markerBudget) return;
        const includedChars = budget - markerBudget;
        excerpt = {
          path: file.path,
          content:
            file.content.slice(0, includedChars) +
            REVIEWER_TRUNCATION_MARKER(originalChars, includedChars),
          truncated: true,
          originalChars,
        };
      }
      bounded.set(file, excerpt);
      remainingChars -= excerpt.content.length;
    };
    group.forEach((file, index) => appendExcerpt(file, budgets[index]));
    // Shares smaller than a truncation marker cannot carry source. Reuse that
    // space for complete small files before spending it on another partial file.
    const omitted = group
      .filter((file) => !bounded.has(file))
      .sort((a, b) => a.content.length - b.content.length);
    for (const file of omitted) appendExcerpt(file, remainingChars);
  }
  return selected
    .map((file) => bounded.get(file))
    .filter((file): file is ReviewerExcerpt => file !== undefined);
}

export function buildReviewerContextFromFiles(input: {
  diff: ReviewerDiff;
  workspaceFiles: ReviewerFile[];
  reviewRequest?: string;
  /** Only opt in when the caller supplies the exact persisted snapshot. */
  includeUnchangedFiles?: boolean;
}): ReviewerWorkspaceContext {
  const requestedPaths = extractRequestedPaths(input.reviewRequest);
  const availableByPath = new Map(
    input.workspaceFiles.map((file) => [normalizePath(file.path), file] as const),
  );
  const availableByBasename = new Map<string, ReviewerFile[]>();
  for (const file of input.workspaceFiles) {
    const name = basename(file.path);
    availableByBasename.set(name, [...(availableByBasename.get(name) ?? []), file]);
  }
  const resolveRequestedFile = (path: string): ReviewerFile | undefined => {
    const normalized = normalizePath(path);
    const exact = availableByPath.get(normalized);
    if (exact) return exact;
    if (normalized.includes("/")) return undefined;
    const basenameMatches = availableByBasename.get(normalized) ?? [];
    return basenameMatches.length === 1 ? basenameMatches[0] : undefined;
  };
  const resolvedRequestedFiles = requestedPaths.map((path) => ({
    requestedPath: path,
    file: resolveRequestedFile(path),
  }));
  const missingRequestedPaths = resolvedRequestedFiles
    .filter((entry) => entry.file === undefined)
    .map((entry) => entry.requestedPath);
  const seenRequestedFiles = new Set<string>();
  const requestedFiles = resolvedRequestedFiles
    .map((entry) => entry.file)
    .filter((file): file is ReviewerFile => {
      if (!file) return false;
      const normalized = normalizePath(file.path);
      if (seenRequestedFiles.has(normalized)) return false;
      seenRequestedFiles.add(normalized);
      return true;
    });
  const requestedFilePaths = new Set(requestedFiles.map((file) => normalizePath(file.path)));
  const changedPaths = new Set(
    [...input.diff.filesAdded, ...input.diff.filesModified].map(normalizePath),
  );
  const remainingFiles = input.workspaceFiles
    .filter(
      (file) =>
        (input.includeUnchangedFiles === true || changedPaths.has(normalizePath(file.path))) &&
        !requestedFilePaths.has(normalizePath(file.path)),
    )
    .sort((a, b) => {
      const changedDelta =
        Number(!changedPaths.has(normalizePath(a.path))) -
        Number(!changedPaths.has(normalizePath(b.path)));
      return changedDelta || compareReviewCandidates(a, b);
    });
  const candidates = [...requestedFiles, ...remainingFiles];

  const fileExcerpts = boundReviewerFileExcerpts(candidates, [
    ...requestedFiles.map((file) => file.path),
    ...input.diff.filesAdded,
    ...input.diff.filesModified,
  ]);

  return {
    diff: input.diff,
    fileExcerpts,
    missingRequestedPaths,
  };
}

export function buildReviewerWorkspaceContext(input: {
  existingFiles: Array<{ path: string }>;
  workspace: ReviewerWorkspace;
  reviewRequest?: string;
}): ReviewerWorkspaceContext {
  const workspaceDiff = input.workspace.diff();
  const initialPaths = new Set(input.existingFiles.map((file) => normalizePath(file.path)));
  const diff = {
    filesAdded: workspaceDiff.changed
      .filter((file) => !initialPaths.has(normalizePath(file.path)))
      .map((file) => file.path),
    filesModified: workspaceDiff.changed
      .filter((file) => initialPaths.has(normalizePath(file.path)))
      .map((file) => file.path),
    filesRemoved: workspaceDiff.removed,
  };

  return buildReviewerContextFromFiles({
    diff,
    workspaceFiles: input.workspace.all?.() ?? workspaceDiff.changed,
    reviewRequest: input.reviewRequest,
  });
}
