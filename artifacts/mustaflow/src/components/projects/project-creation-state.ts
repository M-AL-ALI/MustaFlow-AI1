import type { ProjectInput } from "@workspace/api-client-react";

export const BRIEF_LIMIT = 20000;
export const CREATION_KINDS = [
  "web",
  "fullstack",
  "dashboard",
  "automation",
  "api",
  "mobile-cross",
] as const;
export const CREATION_STACKS = [
  "react-vite",
  "nextjs",
  "node-api",
  "python-flask",
  "python-fastapi",
  "go-gin",
] as const;
export type CreationKind = (typeof CREATION_KINDS)[number];
export type CreationValues = {
  name: string;
  nameEdited: boolean;
  prompt: string;
  platform: "web" | "mobile";
  kind: CreationKind;
  stack: (typeof CREATION_STACKS)[number];
  appMode: "simple" | "fullstack";
  templateId: string | null;
};
export type ProjectReviewDraft = {
  id: string;
  ownerId: string;
  sourceDraftId: string | null;
  values: CreationValues;
  expiresAt: number;
};

const KEY = "nabuflow.project-review.v2";
const TTL = 30 * 60 * 1000;

function reviewKey(ownerId: string): string {
  return KEY + "." + encodeURIComponent(ownerId);
}

export function isCreationKind(value: string): value is CreationKind {
  return CREATION_KINDS.some((kind) => kind === value);
}

export function suggestProjectName(prompt: string): string {
  const subject = prompt
    .trim()
    .replace(/\s+/g, " ")
    .replace(/^(?:please\s+)?(?:build|create|make|design|develop)\s+(?:me\s+)?/i, "")
    .replace(/^(?:a|an|the)\s+/i, "");
  const words = subject
    .split(/[,.;!?]/)[0]
    .trim()
    .split(/\s+/)
    .slice(0, 6)
    .join(" ")
    .slice(0, 80)
    .trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

// Platform is represented by the server's existing kind field, never an extra payload field.
export function projectCreationInput(values: CreationValues, workspaceId?: number): ProjectInput {
  const prompt = values.prompt.trim();
  return {
    name: values.name.trim(),
    description: prompt || undefined,
    initialPrompt: prompt || undefined,
    workspaceId,
    kind:
      values.platform === "mobile"
        ? "mobile-cross"
        : values.kind === "mobile-cross"
          ? "web"
          : values.kind,
    stack: values.platform === "web" ? values.stack : undefined,
    builderMode:
      values.platform === "web" && values.appMode === "fullstack" ? "agentic" : "static-legacy",
  };
}

export function readProjectReviewDraft(ownerId: string): ProjectReviewDraft | null {
  try {
    if (!ownerId.trim()) return null;
    const raw = sessionStorage.getItem(reviewKey(ownerId));
    if (!raw) return null;
    const draft: unknown = JSON.parse(raw);
    if (!draft || typeof draft !== "object") return null;
    const record = draft as Partial<ProjectReviewDraft>;
    const values = record.values;
    if (
      record.ownerId !== ownerId ||
      typeof record.id !== "string" ||
      !record.id ||
      (record.sourceDraftId !== null && typeof record.sourceDraftId !== "string") ||
      typeof record.expiresAt !== "number" ||
      !Number.isFinite(record.expiresAt) ||
      record.expiresAt <= Date.now() ||
      record.expiresAt > Date.now() + TTL ||
      !values ||
      typeof values !== "object" ||
      typeof values.name !== "string" ||
      typeof values.nameEdited !== "boolean" ||
      typeof values.prompt !== "string" ||
      values.prompt.length > BRIEF_LIMIT ||
      (values.platform !== "web" && values.platform !== "mobile") ||
      typeof values.kind !== "string" ||
      !isCreationKind(values.kind) ||
      !CREATION_STACKS.some((stack) => stack === values.stack) ||
      (values.appMode !== "simple" && values.appMode !== "fullstack") ||
      (values.templateId !== null && typeof values.templateId !== "string")
    )
      return null;
    return record as ProjectReviewDraft;
  } catch {
    return null;
  }
}

export function saveProjectReviewDraft(
  ownerId: string,
  values: CreationValues,
  sourceDraftId: string | null,
): ProjectReviewDraft | null {
  try {
    if (!ownerId.trim() || values.prompt.length > BRIEF_LIMIT) return null;
    const draft: ProjectReviewDraft = {
      id: crypto.randomUUID(),
      ownerId,
      sourceDraftId,
      values,
      expiresAt: Date.now() + TTL,
    };
    sessionStorage.setItem(reviewKey(ownerId), JSON.stringify(draft));
    return draft;
  } catch {
    return null;
  }
}

export function clearProjectReviewDraft(ownerId: string, id: string): void {
  try {
    if (!ownerId.trim()) return;
    if (readProjectReviewDraft(ownerId)?.id === id) {
      sessionStorage.removeItem(reviewKey(ownerId));
    }
  } catch {
    // The server has already created the project; storage must not block opening it.
  }
}
