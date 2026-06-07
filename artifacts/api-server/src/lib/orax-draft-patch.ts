import { openai } from "@workspace/integrations-openai-ai-server";

export type OraxDraftPatchFile = {
  path: string;
  content: string;
  size: number;
  sha: string;
};

export type OraxDraftPatch = {
  summary: string;
  explanation: string;
  unifiedDiff: string;
  risks: string[];
  tests: string[];
};

export function buildDraftPatchPrompt(input: {
  repositoryLabel: string;
  taskPrompt: string;
  instructions?: string | null;
  branch: string;
  files: OraxDraftPatchFile[];
}): string {
  const files = input.files
    .map(
      (file) => `--- FILE: ${file.path} (${file.size} bytes, sha ${file.sha}) ---\n${file.content}`,
    )
    .join("\n\n");

  return `You are ORAX, MustaFlow's coding-agent mode.

Task:
${input.taskPrompt}

Repository: ${input.repositoryLabel}
Branch: ${input.branch}
Additional instructions: ${input.instructions?.trim() || "None"}

Approved files:
${files}

Return only strict JSON with this shape:
{
  "summary": "one sentence",
  "explanation": "short explanation",
  "unifiedDiff": "unified diff preview only, or empty string if not enough context",
  "risks": ["risk"],
  "tests": ["test command or manual check"]
}

Rules:
- Produce a reviewable unified diff preview only.
- Do not claim any file was changed.
- Do not include shell commands that mutate files.
- Do not suggest pushing, deploying, or opening a PR.
- If the approved files are insufficient, leave unifiedDiff empty and explain exactly what extra file paths are needed.
- Keep the diff scoped to approved files only.`;
}

export async function generateOraxDraftPatch(input: {
  repositoryLabel: string;
  taskPrompt: string;
  instructions?: string | null;
  branch: string;
  files: OraxDraftPatchFile[];
}): Promise<OraxDraftPatch> {
  const model = process.env.ORAX_DRAFT_PATCH_MODEL || "gpt-5-mini";
  const response = await openai.chat.completions.create({
    model,
    messages: [
      {
        role: "system",
        content:
          "You generate safe draft code patches for review. You never apply changes, run commands, push, deploy, or open pull requests.",
      },
      { role: "user", content: buildDraftPatchPrompt(input) },
    ],
    response_format: { type: "json_object" },
  });

  return parseDraftPatchJson(response.choices[0]?.message?.content ?? "{}");
}

export function parseDraftPatchJson(raw: string): OraxDraftPatch {
  const parsed = JSON.parse(stripCodeFence(raw)) as Partial<OraxDraftPatch>;
  return {
    summary: stringOrFallback(parsed.summary, "Draft patch proposal"),
    explanation: stringOrFallback(parsed.explanation, ""),
    unifiedDiff: stringOrFallback(parsed.unifiedDiff, ""),
    risks: stringArray(parsed.risks),
    tests: stringArray(parsed.tests),
  };
}

function stripCodeFence(raw: string): string {
  const trimmed = raw.trim();
  const match = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return match?.[1]?.trim() ?? trimmed;
}

function stringOrFallback(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}
