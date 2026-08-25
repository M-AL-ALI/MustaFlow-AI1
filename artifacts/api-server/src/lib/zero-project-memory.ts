import { presentZeroProjectChoices, type ZeroProjectChoiceProfile } from "./zero-project-choices";
import type {
  ProjectMemoryReconciliationStatus,
  ProjectMemoryReconciliationSummary,
} from "./memory-reconciliation";

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
  /** Undefined is legacy/test construction; runtime callers must pass a result or null on read failure. */
  reconciliation?: ProjectMemoryReconciliationSummary | null;
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
  memoryTruth?: {
    status: ProjectMemoryReconciliationStatus | "unavailable";
    withheldSources: readonly ZeroProjectMemorySourceKind[];
  };
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

function reconciledSourceIsCurrent(
  source: ZeroProjectMemorySourceKind,
  reconciliation: ProjectMemoryReconciliationSummary | null | undefined,
): boolean {
  if (source === "project-description" || reconciliation === undefined) return true;
  if (reconciliation === null) return false;
  const surfaceId =
    source === "conversation-summary" ? "conversation-summaries" : "project-summary";
  return reconciliation.surfaces.some(
    (surface) => surface.surfaceId === surfaceId && surface.status === "current",
  );
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
  const withheldSources: ZeroProjectMemorySourceKind[] = [];
  for (const candidate of candidates) {
    const text = normalizeBoundedText(candidate.value, candidate.source);
    if (!text || seen.has(text)) continue;
    if (!reconciledSourceIsCurrent(candidate.source, input.reconciliation)) {
      withheldSources.push(candidate.source);
      continue;
    }
    seen.add(text);
    facts.push({ kind: candidate.kind, source: candidate.source, text });
  }

  return {
    semantics: ZERO_PROJECT_MEMORY_SEMANTICS,
    subject: { projectId: input.projectId },
    projectName: input.projectName.trim().slice(0, 200),
    facts,
    choices: input.choices?.subject.projectId === input.projectId ? input.choices : undefined,
    memoryTruth:
      input.reconciliation === undefined
        ? undefined
        : {
            status: input.reconciliation?.status ?? "unavailable",
            withheldSources,
          },
  };
}

export function presentZeroProjectMemory(profile: ZeroProjectMemoryProfile): string | undefined {
  const choices = profile.choices ? presentZeroProjectChoices(profile.choices) : undefined;
  if (profile.facts.length === 0 && !choices && !profile.memoryTruth) return undefined;
  const facts = profile.facts.map(
    ({ kind, source, text }) => `- ${FACT_LABELS[kind]} [${source}]: ${text}`,
  );
  return [
    `PROJECT MEMORY — ${profile.projectName || "this app"}`,
    ...facts,
    ...(choices ? ["", choices] : []),
    ...(profile.memoryTruth?.withheldSources.length
      ? [
          "",
          "Some older app-state memory was withheld because current project records did not confirm it. Rely on the current files and explain any uncertainty plainly.",
        ]
      : profile.memoryTruth?.status === "current"
        ? ["", "Saved app-state memory was checked against current project records."]
        : []),
    "Use this saved context to continue the app without asking the user to repeat it.",
    "Current project files and the user's newest message outrank an older summary if they differ.",
    "Do not present an inference as something the user previously said.",
  ].join("\n");
}

export function zeroProjectMemoryContext(input: ZeroProjectMemoryInput): string | undefined {
  return presentZeroProjectMemory(buildZeroProjectMemoryProfile(input));
}
