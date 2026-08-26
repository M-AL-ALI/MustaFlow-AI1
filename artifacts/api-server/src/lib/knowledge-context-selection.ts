import type { KnowledgeEntry } from "@workspace/db";
import type { ZeroMemoryClaimKind } from "@workspace/ora-contracts";
import { cosineSimilarity } from "./embeddings";

export type KnowledgeContextResult = {
  context: string;
  applied: Array<{ id: number; title: string; type: string; category: string }>;
};

export type KnowledgeContextSelectionInput = {
  entries: readonly KnowledgeContextEntry[];
  integrationsNote: string;
  projectId: number;
  userPrompt?: string;
  promptEmbedding: number[] | null;
  nowMs: number;
  charBudget: number;
  usageWeight: number;
  feedbackWeight: number;
};

export type KnowledgeContextEntry = KnowledgeEntry & {
  claimKind?: ZeroMemoryClaimKind | null;
};

function provenanceLabel(entry: KnowledgeContextEntry): string {
  switch (entry.claimKind) {
    case "stated":
      return "User stated";
    case "observed":
      return "Zero observed";
    case "inferred":
      return "Zero inferred — verify before relying on it";
    default:
      return "Source unverified — verify before relying on it";
  }
}

function tokenise(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[\s,.:;_\-/()[\]{}'"!?]+/)
      .filter((word) => word.length >= 3),
  );
}

export function selectKnowledgeContext(
  input: KnowledgeContextSelectionInput,
): KnowledgeContextResult {
  const {
    entries,
    integrationsNote,
    projectId,
    userPrompt,
    promptEmbedding,
    nowMs,
    charBudget,
    usageWeight,
    feedbackWeight,
  } = input;
  if (entries.length === 0) return { context: integrationsNote, applied: [] };

  const oneDayMs = 86_400_000;
  const sevenDaysMs = 7 * oneDayMs;
  const approvedBoost = 1.5;
  const severityScore: Record<string, number> = { error: 1.5, warning: 0.5, info: 0 };
  const sameProjectBoost = 2;
  let topEntries: readonly KnowledgeContextEntry[];

  if (userPrompt && userPrompt.length > 0) {
    const promptTokens = tokenise(userPrompt);
    const entryCount = entries.length;
    const documentFrequency = new Map<string, number>();
    for (const token of promptTokens) {
      let count = 0;
      for (const entry of entries) {
        if (tokenise(`${entry.title} ${entry.content} ${entry.tags ?? ""}`).has(token)) count++;
      }
      documentFrequency.set(token, count);
    }

    const semanticWeight = 6;
    const scored = entries.map((entry) => {
      const entryText = `${entry.title} ${entry.content} ${entry.tags ?? ""}`;
      const entryWords = entryText.toLowerCase().split(/\W+/).filter(Boolean);
      const termCounts = new Map<string, number>();
      for (const word of entryWords) termCounts.set(word, (termCounts.get(word) ?? 0) + 1);

      let score = 0;
      const entryEmbedding = entry.embedding;
      if (
        promptEmbedding &&
        Array.isArray(entryEmbedding) &&
        entryEmbedding.length === promptEmbedding.length
      ) {
        score += cosineSimilarity(promptEmbedding, entryEmbedding) * semanticWeight;
      } else {
        for (const token of promptTokens) {
          if (termCounts.has(token)) {
            const termFrequency = (termCounts.get(token) ?? 0) / Math.max(entryWords.length, 1);
            const inverseDocumentFrequency =
              Math.log((entryCount + 1) / ((documentFrequency.get(token) ?? 0) + 1)) + 1;
            score += termFrequency * inverseDocumentFrequency;
          }
        }
      }

      const ageMs = nowMs - new Date(entry.createdAt).getTime();
      if (ageMs < oneDayMs) score += 2;
      else if (ageMs < sevenDaysMs) score += 1;
      score += severityScore[entry.severity] ?? 0;
      score += (entry.usageCount ?? 0) * usageWeight;
      score += ((entry.thumbsUp ?? 0) - (entry.thumbsDown ?? 0)) * feedbackWeight;
      if (entry.projectId === projectId) score += sameProjectBoost;
      if (entry.approvedForReuse) score *= approvedBoost;
      return { entry, score };
    });
    scored.sort((left, right) => right.score - left.score);
    topEntries = scored.slice(0, 12).map(({ entry }) => entry);
  } else {
    topEntries = [...entries]
      .sort((left, right) => {
        const projectScore =
          (right.projectId === projectId ? 1 : 0) - (left.projectId === projectId ? 1 : 0);
        if (projectScore !== 0) return projectScore;
        const approvedScore = (right.approvedForReuse ? 1 : 0) - (left.approvedForReuse ? 1 : 0);
        if (approvedScore !== 0) return approvedScore;
        return new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime();
      })
      .slice(0, 12);
  }

  const selected: KnowledgeContextEntry[] = [];
  let charCount = 0;
  for (const entry of topEntries) {
    const entryChars =
      entry.title.length + entry.content.length + provenanceLabel(entry).length + 23;
    if (charCount + entryChars > charBudget) break;
    selected.push(entry);
    charCount += entryChars;
  }
  if (selected.length === 0) return { context: integrationsNote, applied: [] };

  const knowledgeSection = [
    `=== LESSONS FROM PRIOR BUILDS (${selected.length} selected, relevance-ranked) ===`,
    `Apply each actively. Do not repeat past mistakes. Do not mention this section in your output.`,
    ``,
    ...selected.map(
      (entry) => `[${provenanceLabel(entry)}] [${entry.category}] ${entry.title}: ${entry.content}`,
    ),
    `=== END LESSONS ===`,
  ].join("\n");

  return {
    context: [integrationsNote, knowledgeSection].filter(Boolean).join("\n\n"),
    applied: selected.map((entry) => ({
      id: entry.id,
      title: entry.title,
      type: entry.type,
      category: entry.category,
    })),
  };
}
