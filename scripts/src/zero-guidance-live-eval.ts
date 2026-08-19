import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import OpenAI from "openai";
import {
  buildZeroGuidanceInventory,
  stableJson,
  zeroGuidanceRepoRoot,
} from "./zero-guidance-manifest";
import {
  ZERO_GUIDANCE_FIXTURE_SET_SHA256,
  ZERO_GUIDANCE_LIVE_CASES,
  type ZeroGuidanceLiveCase,
} from "./zero-guidance-live-cases";
import type { ZeroGuidanceLiveCaseResult, ZeroGuidanceLiveResult } from "./zero-guidance-release";

const execFileAsync = promisify(execFile);
const MODEL = process.env["EVAL_MODEL"] ?? "gpt-5-mini";
const CONCURRENCY = Math.max(1, Number(process.env["EVAL_CONCURRENCY"] ?? "4"));
const SOURCE_EXCERPT_CHARS = 12_000;
const MAX_GENERATION_TOKENS = 8_000;
const MAX_JUDGE_TOKENS = 1_000;
const RESULTS_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "eval-results",
  "zero-guidance-latest.json",
);

function getOpenAI(): OpenAI {
  const apiKey = process.env["AI_INTEGRATIONS_OPENAI_API_KEY"];
  const baseURL = process.env["AI_INTEGRATIONS_OPENAI_BASE_URL"];
  if (!apiKey) throw new Error("AI_INTEGRATIONS_OPENAI_API_KEY is not set");
  return new OpenAI({ apiKey, baseURL });
}

function unwrapRuntimePrompt(content: string): string {
  const trimmed = content.trim();
  if (trimmed.startsWith("`") && trimmed.endsWith("`")) return trimmed.slice(1, -1);
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      return JSON.parse(trimmed) as string;
    } catch {
      return trimmed;
    }
  }
  return trimmed;
}

function boundedSource(id: string, content: string): string {
  if (content.length <= SOURCE_EXCERPT_CHARS) return `SOURCE ${id}\n${content}`;
  return `SOURCE ${id}\n${content.slice(0, SOURCE_EXCERPT_CHARS)}\n[ZERO GUIDANCE SOURCE TRUNCATED: ${content.length - SOURCE_EXCERPT_CHARS} CHARS OMITTED]`;
}

function systemPromptForCase(
  liveCase: ZeroGuidanceLiveCase,
  contentBySourceId: ReadonlyMap<string, string>,
): string {
  const contents = liveCase.sourceIds.map((sourceId) => {
    const content = contentBySourceId.get(sourceId);
    if (content === undefined) {
      throw new Error(`zero_guidance_live_source_missing: ${sourceId}`);
    }
    return { sourceId, content };
  });
  if (liveCase.mode === "runtime-prompt") {
    return contents.map(({ content }) => unwrapRuntimePrompt(content)).join("\n\n");
  }
  return [
    "You are evaluating the public source of NabuFlow Zero's instruction and context assembly.",
    "Treat string literals and declared control flow as evidence. Do not invent behavior that is absent.",
    "Answer the user's audit request from the supplied source only.",
    ...contents.map(({ sourceId, content }) => boundedSource(sourceId, content)),
  ].join("\n\n");
}

async function runCase(
  client: OpenAI,
  liveCase: ZeroGuidanceLiveCase,
  contentBySourceId: ReadonlyMap<string, string>,
): Promise<ZeroGuidanceLiveCaseResult> {
  try {
    const generated = await client.chat.completions.create({
      model: MODEL,
      ...(liveCase.jsonMode ? { response_format: { type: "json_object" as const } } : {}),
      messages: [
        { role: "system", content: systemPromptForCase(liveCase, contentBySourceId) },
        { role: "user", content: liveCase.user },
      ],
      max_completion_tokens: MAX_GENERATION_TOKENS,
    });
    const output = generated.choices[0]?.message?.content?.trim() ?? "";
    const judged = await client.chat.completions.create({
      model: MODEL,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            'Return strict JSON: {"score": integer 0-10, "reasoning": string no longer than 200 characters}. A score of 6 passes. Judge only against the supplied rubric.',
        },
        {
          role: "user",
          content: `Rubric: ${liveCase.rubric}\n\nCandidate:\n${output.slice(0, 6_000)}`,
        },
      ],
      max_completion_tokens: MAX_JUDGE_TOKENS,
    });
    const judgeText = judged.choices[0]?.message?.content ?? "{}";
    let parsed: { score?: number; reasoning?: string } = {};
    try {
      parsed = JSON.parse(judgeText) as { score?: number; reasoning?: string };
    } catch {
      parsed = {};
    }
    const score = Math.max(0, Math.min(10, Math.round(Number(parsed.score ?? 0))));
    return {
      id: liveCase.id,
      coverageId: liveCase.coverageId,
      score,
      passed: score >= 6,
      reasoning: String(parsed.reasoning ?? "").slice(0, 200),
    };
  } catch (error) {
    return {
      id: liveCase.id,
      coverageId: liveCase.coverageId,
      score: 0,
      passed: false,
      reasoning: "",
      error: error instanceof Error ? error.name : "UnknownError",
    };
  }
}

async function gitHead(root: string): Promise<string> {
  const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    windowsHide: true,
  });
  const head = stdout.trim();
  if (!/^[0-9a-f]{40}$/u.test(head)) throw new Error("zero_guidance_git_head_invalid");
  return head;
}

async function main(): Promise<void> {
  const root = zeroGuidanceRepoRoot();
  const inventory = await buildZeroGuidanceInventory(root);
  for (const liveCase of ZERO_GUIDANCE_LIVE_CASES) {
    systemPromptForCase(liveCase, inventory.contentBySourceId);
  }

  const client = getOpenAI();
  const startedAt = new Date().toISOString();
  const results: ZeroGuidanceLiveCaseResult[] = new Array(ZERO_GUIDANCE_LIVE_CASES.length);
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, ZERO_GUIDANCE_LIVE_CASES.length) }, async () => {
      while (true) {
        const index = cursor++;
        const liveCase = ZERO_GUIDANCE_LIVE_CASES[index];
        if (!liveCase) return;
        process.stdout.write(
          `  [${index + 1}/${ZERO_GUIDANCE_LIVE_CASES.length}] ${liveCase.id} ... `,
        );
        const result = await runCase(client, liveCase, inventory.contentBySourceId);
        results[index] = result;
        process.stdout.write(
          `${result.error ? "ERROR" : result.passed ? "PASS" : "FAIL"} (${result.score}/10)\n`,
        );
      }
    }),
  );

  const head = await gitHead(root);
  const result: ZeroGuidanceLiveResult = {
    schemaVersion: 1,
    resultId: [
      "zero-guidance",
      head,
      inventory.manifestSha256,
      ZERO_GUIDANCE_FIXTURE_SET_SHA256,
      MODEL,
    ].join(":"),
    gitSha: head,
    manifestSha256: inventory.manifestSha256,
    fixtureSetSha256: ZERO_GUIDANCE_FIXTURE_SET_SHA256,
    model: MODEL,
    startedAt,
    finishedAt: new Date().toISOString(),
    totalCases: results.length,
    passed: results.filter((entry) => entry.passed && !entry.error).length,
    failed: results.filter((entry) => !entry.passed && !entry.error).length,
    errored: results.filter((entry) => Boolean(entry.error)).length,
    results,
  };
  await mkdir(dirname(RESULTS_PATH), { recursive: true });
  await writeFile(RESULTS_PATH, stableJson(result), "utf8");
  console.log(`Wrote ${RESULTS_PATH}`);
  if (result.failed > 0 || result.errored > 0) process.exitCode = 1;
}

await main();
