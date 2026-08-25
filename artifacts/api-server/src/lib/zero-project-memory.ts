import { presentZeroProjectChoices, type ZeroProjectChoiceProfile } from "./zero-project-choices";

export const ZERO_PROJECT_MEMORY_SEMANTICS = "zero-project-memory-v1" as const;

export const ZERO_PROJECT_MEMORY_FACT_KINDS = [
  "purpose-and-audience",
  "built-state",
  "latest-work",
  "conversation-continuity",
] as const;

export type ZeroProjectMemoryFactKind = (typeof ZERO_PROJECT_MEMORY_FACT_KINDS)[number];

export const ZERO_PROJECT_MEMORY_SOURCE_KINDS = [
  "project-description",
  "project-summary",
  "last-task-summary",
  "conversation-summary",
] as const;

export type ZeroProjectMemorySourceKind = (typeof ZERO_PROJECT_MEMORY_SOURCE_KINDS)[number];

export type ZeroProjectMemoryInput = {
  projectId: number;
  projectName: string;
  description?: string | null;
  summary?: string | null;
  lastTaskSummary?: string | null;
  conversationSummary?: string | null;
  choices?: ZeroProjectChoiceProfile | null;
};

export type ZeroProjectMemoryFact = {
  kind: ZeroProjectMemoryFactKind;
  source: ZeroProjectMemorySourceKind;
  text: string;
};

export type ZeroProjectMemoryProfile = {
  semantics: typeof ZERO_PROJECT_MEMORY_SEMANTICS;
  subject: { projectId: number };
  projectName: string;
  facts: readonly ZeroProjectMemoryFact[];
  choices?: ZeroProjectChoiceProfile;
};

const SOURCE_LIMITS: Readonly<Record<ZeroProjectMemorySourceKind, number>> = {
  "project-description": 1_200,
  "project-summary": 1_600,
  "last-task-summary": 300,
  "conversation-summary": 2_000,
};

const FACT_LABELS: Readonly<Record<ZeroProjectMemoryFactKind, string>> = {
  "purpose-and-audience": "Purpose and audience",
  "built-state": "What is built now",
  "latest-work": "Latest work",
  "conversation-continuity": "Earlier conversation",
};

function normalizeBoundedText(
  value: string | null | undefined,
  source: ZeroProjectMemorySourceKind,
): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) return null;
  const limit = SOURCE_LIMITS[source];
  return normalized.length <= limit ? normalized : `${normalized.slice(0, limit - 1)}…`;
}

export function buildZeroProjectMemoryProfile(
  input: ZeroProjectMemoryInput,
): ZeroProjectMemoryProfile {
  if (!Number.isSafeInteger(input.projectId) || input.projectId <= 0) {
    throw new Error("zero_project_memory_subject_invalid");
  }

  const candidates: ReadonlyArray<{
    kind: ZeroProjectMemoryFactKind;
    source: ZeroProjectMemorySourceKind;
    value: string | null | undefined;
  }> = [
    {
      kind: "purpose-and-audience",
      source: "project-description",
      value: input.description,
    },
    { kind: "built-state", source: "project-summary", value: input.summary },
    { kind: "latest-work", source: "last-task-summary", value: input.lastTaskSummary },
    {
      kind: "conversation-continuity",
      source: "conversation-summary",
      value: input.conversationSummary,
    },
  ];

  const seen = new Set<string>();
  const facts: ZeroProjectMemoryFact[] = [];
  for (const candidate of candidates) {
    const text = normalizeBoundedText(candidate.value, candidate.source);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    facts.push({ kind: candidate.kind, source: candidate.source, text });
  }

  return {
    semantics: ZERO_PROJECT_MEMORY_SEMANTICS,
    subject: { projectId: input.projectId },
    projectName: input.projectName.trim().slice(0, 200),
    facts,
    choices: input.choices?.subject.projectId === input.projectId ? input.choices : undefined,
  };
}

export function presentZeroProjectMemory(profile: ZeroProjectMemoryProfile): string | undefined {
  const choices = profile.choices ? presentZeroProjectChoices(profile.choices) : undefined;
  if (profile.facts.length === 0 && !choices) return undefined;
  const facts = profile.facts.map(
    ({ kind, source, text }) => `- ${FACT_LABELS[kind]} [${source}]: ${text}`,
  );
  return [
    `PROJECT MEMORY — ${profile.projectName || "this app"}`,
    ...facts,
    ...(choices ? ["", choices] : []),
    "Use this saved context to continue the app without asking the user to repeat it.",
    "Current project files and the user's newest message outrank an older summary if they differ.",
    "Do not present an inference as something the user previously said.",
  ].join("\n");
}

export function zeroProjectMemoryContext(input: ZeroProjectMemoryInput): string | undefined {
  return presentZeroProjectMemory(buildZeroProjectMemoryProfile(input));
}
