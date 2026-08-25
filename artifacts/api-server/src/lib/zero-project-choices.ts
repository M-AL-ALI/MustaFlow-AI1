export const ZERO_PROJECT_CHOICES_SEMANTICS = "zero-project-choices-v1" as const;

export const ZERO_PROJECT_CHOICE_KINDS = ["accepted-decision", "explicit-rejection"] as const;
export type ZeroProjectChoiceKind = (typeof ZERO_PROJECT_CHOICE_KINDS)[number];

export const ZERO_PROJECT_CHOICE_SOURCE_KINDS = ["user-message", "project-knowledge"] as const;
export type ZeroProjectChoiceSourceKind = (typeof ZERO_PROJECT_CHOICE_SOURCE_KINDS)[number];

export type ZeroProjectChoiceSource = {
  kind: ZeroProjectChoiceSourceKind;
  id: number;
};

export type ZeroProjectChoice = {
  kind: ZeroProjectChoiceKind;
  text: string;
  source: ZeroProjectChoiceSource;
};

export type ZeroProjectChoiceProfile = {
  semantics: typeof ZERO_PROJECT_CHOICES_SEMANTICS;
  subject: { projectId: number };
  choices: readonly ZeroProjectChoice[];
};

export type ZeroProjectChoiceInput = {
  projectId: number;
  /** Persisted user evidence. Ordering is derived from occurredAt and id. */
  userMessages?: readonly { id: number; content: string; occurredAt: string }[];
  /** Active typed project evidence. Ordering is derived from occurredAt and id. */
  knowledgeEntries?: readonly {
    id: number;
    type: "decision" | "rejection";
    content: string;
    occurredAt: string;
  }[];
};

const MAX_CHOICES = 12;
const MAX_CHOICE_TEXT = 800;

const TAGGED_MESSAGE_PATTERNS: ReadonlyArray<{
  kind: ZeroProjectChoiceKind;
  pattern: RegExp;
}> = [
  {
    kind: "accepted-decision",
    pattern: /save this as (?:a )?project decision\s*:\s*([^\n.!?]+[.!?]?)/giu,
  },
  {
    kind: "explicit-rejection",
    pattern: /save this as (?:a )?project rejection\s*:\s*([^\n.!?]+[.!?]?)/giu,
  },
];

function normalizeChoiceText(value: string): string | null {
  const normalized = value
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.!?]+$/, "")
    .trim();
  if (!normalized) return null;
  return normalized.length <= MAX_CHOICE_TEXT
    ? normalized
    : `${normalized.slice(0, MAX_CHOICE_TEXT - 1)}…`;
}

function addChoice(
  choices: ZeroProjectChoice[],
  seen: Set<string>,
  choice: ZeroProjectChoice,
): void {
  const dedupeKey = choice.text.toLowerCase();
  if (choices.length >= MAX_CHOICES || seen.has(dedupeKey)) return;
  seen.add(dedupeKey);
  choices.push(choice);
}

export function buildZeroProjectChoiceProfile(
  input: ZeroProjectChoiceInput,
): ZeroProjectChoiceProfile {
  if (!Number.isSafeInteger(input.projectId) || input.projectId <= 0) {
    throw new Error("zero_project_choices_subject_invalid");
  }

  const choices: ZeroProjectChoice[] = [];
  const seen = new Set<string>();

  const candidates: Array<ZeroProjectChoice & { occurredAt: string }> = [];
  for (const entry of input.knowledgeEntries ?? []) {
    const text = normalizeChoiceText(entry.content);
    if (text) {
      candidates.push({
        kind: entry.type === "decision" ? "accepted-decision" : "explicit-rejection",
        text,
        source: { kind: "project-knowledge", id: entry.id },
        occurredAt: entry.occurredAt,
      });
    }
  }

  for (const message of input.userMessages ?? []) {
    for (const { kind, pattern } of TAGGED_MESSAGE_PATTERNS) {
      pattern.lastIndex = 0;
      for (const match of message.content.matchAll(pattern)) {
        const text = normalizeChoiceText(match[1] ?? "");
        if (text) {
          candidates.push({
            kind,
            text,
            source: { kind: "user-message", id: message.id },
            occurredAt: message.occurredAt,
          });
        }
      }
    }
  }

  candidates.sort((left, right) => {
    if (left.occurredAt < right.occurredAt) return 1;
    if (left.occurredAt > right.occurredAt) return -1;
    return right.source.id - left.source.id;
  });
  for (const { occurredAt: _occurredAt, ...candidate } of candidates) {
    addChoice(choices, seen, candidate);
  }

  return {
    semantics: ZERO_PROJECT_CHOICES_SEMANTICS,
    subject: { projectId: input.projectId },
    choices,
  };
}

export function presentZeroProjectChoices(profile: ZeroProjectChoiceProfile): string | undefined {
  if (profile.choices.length === 0) return undefined;
  return [
    "VERIFIED PROJECT DECISIONS AND REJECTIONS",
    ...profile.choices.map(({ kind, source, text }) => {
      const label = kind === "accepted-decision" ? "Accepted decision" : "Explicit rejection";
      return `- ${label} [${source.kind}#${source.id}]: ${text}`;
    }),
    "Honor explicit rejections as project constraints; do not propose or build them unless the user's newest message explicitly reverses one.",
    "These choices are source-bound. Do not infer an unrecorded choice or describe one as the user's decision.",
  ].join("\n");
}
