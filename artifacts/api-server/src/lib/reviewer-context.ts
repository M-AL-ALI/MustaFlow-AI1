type ReviewerFile = {
  path: string;
  content: string;
};

type ReviewerWorkspace = {
  diff(): {
    changed: ReviewerFile[];
    removed: string[];
  };
};

export type ReviewerWorkspaceContext = {
  diff: {
    filesAdded: string[];
    filesModified: string[];
    filesRemoved: string[];
  };
  fileExcerpts: Array<{ path: string; content: string }>;
};

const REVIEWER_MAX_FILE_EXCERPTS = 8;
const REVIEWER_MAX_EXCERPT_CHARS = 6_000;
const REVIEWER_MAX_TOTAL_EXCERPT_CHARS = 30_000;

export function buildReviewerWorkspaceContext(input: {
  existingFiles: Array<{ path: string }>;
  workspace: ReviewerWorkspace;
}): ReviewerWorkspaceContext {
  const workspaceDiff = input.workspace.diff();
  const initialPaths = new Set(input.existingFiles.map((file) => file.path));
  const filesAdded = workspaceDiff.changed
    .filter((file) => !initialPaths.has(file.path))
    .map((file) => file.path);
  const filesModified = workspaceDiff.changed
    .filter((file) => initialPaths.has(file.path))
    .map((file) => file.path);

  let remainingChars = REVIEWER_MAX_TOTAL_EXCERPT_CHARS;
  const fileExcerpts: ReviewerWorkspaceContext["fileExcerpts"] = [];
  for (const file of workspaceDiff.changed.slice(0, REVIEWER_MAX_FILE_EXCERPTS)) {
    if (remainingChars <= 0) break;
    const content = file.content.slice(0, Math.min(REVIEWER_MAX_EXCERPT_CHARS, remainingChars));
    fileExcerpts.push({ path: file.path, content });
    remainingChars -= content.length;
  }

  return {
    diff: {
      filesAdded,
      filesModified,
      filesRemoved: workspaceDiff.removed,
    },
    fileExcerpts,
  };
}
