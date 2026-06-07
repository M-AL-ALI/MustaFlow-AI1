export type OraxProvider = "github" | "gitlab" | "bitbucket" | "azure-devops" | "other";
export type OraxTaskKind = "analyze" | "plan" | "review" | "fix";

export interface ParsedRepositoryLocator {
  provider: OraxProvider;
  owner: string;
  name: string;
  repositoryUrl: string;
  defaultBranch: string;
}

export interface OraxPlan {
  mode: "read_only_foundation";
  objective: string;
  steps: string[];
  guardrails: string[];
  unavailableUntilApproved: string[];
}

export const ORAX_FILE_READ_LIMITS = {
  maxFiles: 12,
  maxFileBytes: 100_000,
  maxTotalBytes: 400_000,
} as const;

const PROVIDER_HOSTS: Array<{ host: string; provider: OraxProvider }> = [
  { host: "github.com", provider: "github" },
  { host: "gitlab.com", provider: "gitlab" },
  { host: "bitbucket.org", provider: "bitbucket" },
  { host: "dev.azure.com", provider: "azure-devops" },
];

export function parseRepositoryLocator(input: {
  repositoryUrl: string;
  defaultBranch?: string;
  provider?: OraxProvider;
}): ParsedRepositoryLocator {
  const rawUrl = input.repositoryUrl.trim();
  const normalized = normalizeRepositoryUrl(rawUrl);
  const url = new URL(normalized);
  const pathParts = url.pathname
    .replace(/\.git$/i, "")
    .split("/")
    .filter(Boolean);

  if (pathParts.length < 2) {
    throw new Error("Repository URL must include an owner and repository name");
  }

  const detectedProvider =
    input.provider ??
    PROVIDER_HOSTS.find((candidate) => url.hostname.toLowerCase() === candidate.host)?.provider ??
    "other";

  // Azure DevOps URLs usually look like /org/project/_git/repo. For Phase 1
  // metadata, preserve the first segment as owner and the last as repo name.
  const owner = sanitizeSegment(pathParts[0], "owner");
  const name = sanitizeSegment(pathParts[pathParts.length - 1], "repository name");
  const defaultBranch = sanitizeSegment(input.defaultBranch?.trim() || "main", "default branch");

  return {
    provider: detectedProvider,
    owner,
    name,
    repositoryUrl: normalized,
    defaultBranch,
  };
}

export function buildOraxTaskPlan(input: {
  kind: OraxTaskKind;
  repository: { provider: string; owner: string; name: string; defaultBranch: string };
  prompt: string;
}): OraxPlan {
  const objective = input.prompt.trim();
  const repoLabel = `${input.repository.owner}/${input.repository.name}`;
  return {
    mode: "read_only_foundation",
    objective,
    steps: [
      `Confirm the repository target: ${repoLabel} on ${input.repository.provider}.`,
      `Classify the request as ${input.kind} work and identify the likely files, tests, and risks.`,
      "Prepare a reviewable implementation plan before any file writes.",
      "Wait for explicit user approval before editing files, running destructive commands, pushing, or opening PRs.",
    ],
    guardrails: [
      "ORAX is separate from Ora chat memory and AI Builder project tasks.",
      "Provider tokens are encrypted and used only for read-only repository scans.",
      "Write, push, deploy, and delete actions require a later approval-gated execution layer.",
      "Every future code change must produce a diff, test result, and audit entry before push.",
    ],
    unavailableUntilApproved: [
      "Direct repository cloning",
      "File modifications",
      "Terminal execution",
      "Branch creation",
      "Git push",
      "Pull request creation",
      "Deployment changes",
    ],
  };
}

export function normalizeOraxFileReadPaths(paths: string[]): string[] {
  if (!Array.isArray(paths)) {
    throw new Error("File paths must be an array");
  }
  const normalized = paths.map((path) => path.trim().replace(/\\/g, "/")).filter(Boolean);
  const unique = [...new Set(normalized)];

  if (unique.length === 0) {
    throw new Error("At least one file path is required");
  }
  if (unique.length > ORAX_FILE_READ_LIMITS.maxFiles) {
    throw new Error(`At most ${ORAX_FILE_READ_LIMITS.maxFiles} files can be read at once`);
  }

  for (const path of unique) {
    if (path.length > 300) {
      throw new Error("File paths must be 300 characters or less");
    }
    if (path.startsWith("/") || /^[A-Za-z]:\//.test(path)) {
      throw new Error("File paths must be repository-relative");
    }
    if (path.split("/").some((part) => part === ".." || part === "." || part === "")) {
      throw new Error("File paths cannot contain traversal segments");
    }
    if (/[\0\r\n]/.test(path)) {
      throw new Error("File paths contain invalid characters");
    }
  }

  return unique;
}

function normalizeRepositoryUrl(raw: string): string {
  if (!raw) throw new Error("Repository URL is required");
  if (/^git@/i.test(raw)) {
    const match = raw.match(/^git@([^:]+):(.+)$/i);
    if (!match) throw new Error("Unsupported SSH repository URL");
    return `https://${match[1]}/${match[2].replace(/\.git$/i, "")}`;
  }
  if (!/^https?:\/\//i.test(raw)) {
    throw new Error("Repository URL must start with https:// or git@");
  }
  return raw.replace(/\.git$/i, "");
}

function sanitizeSegment(value: string, label: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(value)) {
    throw new Error(`Invalid ${label}`);
  }
  return value;
}
