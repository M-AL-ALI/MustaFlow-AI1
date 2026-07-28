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
  fileExcerpts: Array<{ path: string; content: string }>;
  missingRequestedPaths: string[];
};

export type ReviewerDiff = ReviewerWorkspaceContext["diff"];

const REVIEWER_MAX_FILE_EXCERPTS = 8;
const REVIEWER_MAX_EXCERPT_CHARS = 6_000;
const REVIEWER_MAX_TOTAL_EXCERPT_CHARS = 30_000;
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

export function buildReviewerContextFromFiles(input: {
  diff: ReviewerDiff;
  workspaceFiles: ReviewerFile[];
  reviewRequest?: string;
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
  const remainingChangedFiles = input.workspaceFiles
    .filter(
      (file) =>
        changedPaths.has(normalizePath(file.path)) &&
        !requestedFilePaths.has(normalizePath(file.path)),
    )
    .sort(compareReviewCandidates);
  const candidates = [...requestedFiles, ...remainingChangedFiles];

  let remainingChars = REVIEWER_MAX_TOTAL_EXCERPT_CHARS;
  const fileExcerpts: ReviewerWorkspaceContext["fileExcerpts"] = [];
  for (const file of candidates) {
    if (fileExcerpts.length >= REVIEWER_MAX_FILE_EXCERPTS) break;
    if (remainingChars <= 0) break;
    const content = file.content.slice(0, Math.min(REVIEWER_MAX_EXCERPT_CHARS, remainingChars));
    fileExcerpts.push({ path: file.path, content });
    remainingChars -= content.length;
  }

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
