/**
 * Prompt eval harness (Task #545).
 *
 * Exercises the REAL production system prompts from
 * `artifacts/api-server/src/lib/builder.ts` and `architect.ts` against a
 * curated fixture set, scores each output with a rubric judge call, and
 * compares the run against the saved baseline. CI fails the run when more
 * than 10% of fixtures regress.
 *
 * Stages covered (the same prompts MustaFlow ships):
 *   build      → BUILD_SYSTEM_PROMPT          (returns JSON {files,…})
 *   refine     → REFINE_SYSTEM_PROMPT         (returns JSON {files,…})
 *   plan       → PLAN_SYSTEM_PROMPT           (returns JSON {summary,…})
 *   intent     → INTENT_CLASSIFIER_SYSTEM     (returns the typed intent contract)
 *   converse   → CONVERSE_SYSTEM_PROMPT       (free-form helpful reply)
 *   architect  → ARCHITECT_SYSTEM_PROMPT      (returns JSON verdict)
 *
 * Outputs:
 *   scripts/eval-results/latest.json   — full run record + per-fixture details
 *   scripts/eval-results/baseline.json — first run; updated only with --update-baseline
 *
 * Exit codes:
 *   0 — no regression (or first run)
 *   1 — regression: > REGRESSION_THRESHOLD of fixtures lost vs baseline
 *
 * Usage:
 *   pnpm --filter @workspace/scripts run eval-prompts
 *   pnpm --filter @workspace/scripts run eval-prompts -- --update-baseline
 *
 * Env:
 *   AI_INTEGRATIONS_OPENAI_API_KEY, AI_INTEGRATIONS_OPENAI_BASE_URL
 *   EVAL_MODEL (default gpt-5-mini) — model used for generation AND rubric judge.
 *   EVAL_CONCURRENCY (default 4) — parallel calls.
 */
import { writeFile, readFile, mkdir } from "fs/promises";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import OpenAI from "openai";
import {
  buildPromptEvalCandidateEvidence,
  classifyPromptEvalGeneration,
  parsePromptEvalJudgeDecision,
  promptEvalJudgeInstruction,
} from "./prompt-eval-evidence";

// Import the REAL production prompts. If any of these moves or is renamed
// in builder.ts/architect.ts, this script breaks loudly at startup — which is
// exactly what we want: the eval should never silently drift from prod.
import {
  BUILD_SYSTEM_PROMPT,
  REFINE_SYSTEM_PROMPT,
  PLAN_SYSTEM_PROMPT,
  INTENT_CLASSIFIER_SYSTEM,
  CONVERSE_SYSTEM_PROMPT,
} from "../../artifacts/api-server/src/lib/builder.js";
import { ARCHITECT_SYSTEM_PROMPT } from "../../artifacts/api-server/src/lib/architect.js";

type Stage = "build" | "refine" | "plan" | "intent" | "converse" | "architect";

interface Fixture {
  id: string;
  stage: Stage;
  /** User message sent to the real system prompt for this stage. */
  user: string;
  /** Rubric the judge model uses to score 0–10. */
  rubric: string;
  /** True if the stage prompt expects JSON-mode output. */
  jsonMode: boolean;
}

interface FixtureResult {
  id: string;
  stage: Stage;
  score: number; // 0–10
  passed: boolean; // score >= 6
  reasoning: string;
  outputPreview: string;
  outputChars: number;
  outputSha256: string;
  candidateEvidenceChars: number;
  jsonValid: boolean | null;
  generationAttempts: number;
  error?: string;
}

interface RunRecord {
  startedAt: string;
  finishedAt: string;
  model: string;
  totalFixtures: number;
  passed: number;
  failed: number;
  errored: number;
  perStage: Record<Stage, { passed: number; failed: number; avgScore: number }>;
  results: FixtureResult[];
}

interface ComparisonRecord {
  winners: { id: string; from: number; to: number }[];
  losers: { id: string; from: number; to: number }[];
  ties: string[];
  totalDeltaScore: number;
  regressionRatio: number; // losers / totalFixtures
}

const REGRESSION_THRESHOLD = 0.1; // 10% — task spec

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const RESULTS_DIR = join(__dirname, "..", "eval-results");
const LATEST_PATH = join(RESULTS_DIR, "latest.json");
const BASELINE_PATH = join(RESULTS_DIR, "baseline.json");

// Stage prompts → real production strings (with a small per-stage user-prep
// wrapper so each fixture's "user" content matches what runtime callers send).
const STAGE_PROMPT: Record<Stage, string> = {
  build: BUILD_SYSTEM_PROMPT,
  refine: REFINE_SYSTEM_PROMPT,
  plan: PLAN_SYSTEM_PROMPT,
  intent: INTENT_CLASSIFIER_SYSTEM,
  converse: CONVERSE_SYSTEM_PROMPT,
  architect: ARCHITECT_SYSTEM_PROMPT,
};

const _STAGE_JSON_MODE: Record<Stage, boolean> = {
  build: true,
  refine: true,
  plan: true,
  intent: true, // INTENT_CLASSIFIER_SYSTEM returns strict JSON {intent, confidence}
  converse: false,
  architect: true,
};

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures — 5 per stage × 6 stages = 30
// ─────────────────────────────────────────────────────────────────────────────
const FIXTURES: Fixture[] = [
  // build — initial generation. Judges check the JSON shape from BUILD_SYSTEM_PROMPT.
  {
    id: "build-todo",
    stage: "build",
    user: "Build a single-page todo app with add, complete, and delete actions.",
    rubric:
      "Output is valid JSON with a non-empty `files` array; includes an `index.html`; the HTML or accompanying JS implements add/complete/delete; references localStorage or stateful re-render.",
    jsonMode: true,
  },
  {
    id: "build-pricing",
    stage: "build",
    user: "Build a SaaS pricing page with three tiers (Free, Pro, Enterprise) and a feature comparison.",
    rubric:
      "Valid JSON with `files`+`index.html`; HTML mentions Free/Pro/Enterprise tier names; describes columns/cards layout and feature comparison.",
    jsonMode: true,
  },
  {
    id: "build-portfolio",
    stage: "build",
    user: "Build a one-page photographer portfolio with a hero, gallery grid, and contact form.",
    rubric:
      "Valid JSON with `files`+`index.html`; markup includes hero section, gallery grid, contact form fields.",
    jsonMode: true,
  },
  {
    id: "build-counter",
    stage: "build",
    user: "Build a click counter that persists across page reloads.",
    rubric: "Valid JSON with `files`+`index.html`; JS uses localStorage or sessionStorage.",
    jsonMode: true,
  },
  {
    id: "build-form",
    stage: "build",
    user: "Build a contact form with name, email, message — validate email on submit.",
    rubric:
      "Valid JSON with `files`+`index.html`; form has name/email/message inputs; includes email validation (type=email or regex).",
    jsonMode: true,
  },

  // refine — change requests. Real REFINE_SYSTEM_PROMPT expects JSON {files,patches?,filesRemoved,unchangedFiles}.
  {
    id: "refine-dark-mode",
    stage: "refine",
    user: 'Project: "Landing" (kind: web).\n\nCURRENT PROJECT FILES:\n--- index.html (text/html) ---\n<!doctype html><html><body><main><h1>Welcome</h1><p>Our product helps small teams.</p></main></body></html>\n\nApply this change: Add a dark mode toggle that remembers the choice.',
    rubric:
      "Valid JSON with `files` and/or `patches` for changed content; change implements a toggle (class swap or CSS vars) AND uses localStorage; includes `unchangedFiles` array.",
    jsonMode: true,
  },
  {
    id: "refine-mobile",
    stage: "refine",
    user: 'Project: "Dashboard" (kind: web).\n\nCURRENT PROJECT FILES:\n--- index.html (text/html) ---\n<!doctype html><html><body><main><h1>Dashboard</h1><section class="cards"><article><h2>Revenue</h2><p>$12,400</p></article><article><h2>Users</h2><p>842</p></article></section></main></body></html>\n\nApply this change: Make it look good on phones too without losing any data.',
    rubric:
      "Valid JSON with `files` and/or `patches`; HTML/CSS uses responsive breakpoints (media queries / flex / grid); no data fields removed.",
    jsonMode: true,
  },
  {
    id: "refine-validation",
    stage: "refine",
    user: 'Project: "Signup" (kind: web).\n\nCURRENT PROJECT FILES:\n--- index.html (text/html) ---\n<!doctype html><html><body><form id="signup"><label>Name<input name="name"></label><label>Email<input name="email" type="email"></label><button type="submit">Join</button></form></body></html>\n\nApply this change: Show a friendly inline error if the email is missing or invalid.',
    rubric:
      "Valid JSON with `files` and/or `patches`; change references an inline error message and email format check; no blocking alert().",
    jsonMode: true,
  },
  {
    id: "refine-typo",
    stage: "refine",
    user: 'Project: "Welcome" (kind: web).\n\nCURRENT PROJECT FILES:\n--- index.html (text/html) ---\n<!doctype html><html><body><h1>Wlcome</h1><p>Existing copy stays here.</p></body></html>\n\nApply this change: Fix the typo — should be Welcome.',
    rubric:
      "Valid JSON with `files` and/or `patches`; only changes Wlcome → Welcome. A surgical patch with find=Wlcome and replace=Welcome is perfect; a full file passes only when every other byte is preserved.",
    jsonMode: true,
  },
  {
    id: "refine-add-row",
    stage: "refine",
    user: 'Project: "Pricing" (kind: web).\n\nCURRENT PROJECT FILES:\n--- index.html (text/html) ---\n<!doctype html><html><body><main><section id="pricing"><article>Free — $0/mo</article><article>Pro — $19/mo</article><article>Enterprise — Contact us</article></section></main></body></html>\n\nApply this change: Add a fourth tier called Team at $49/mo.',
    rubric:
      "Valid JSON with `files` and/or `patches`; new 'Team' card with $49/mo added; existing tier names preserved.",
    jsonMode: true,
  },

  // plan — Plan Mode JSON.
  {
    id: "plan-blog",
    stage: "plan",
    user: "Plan a personal blog with homepage, post detail page, and an about page.",
    rubric:
      "Valid JSON matching PLAN_SYSTEM_PROMPT shape: contains `summary` string and `pages` array with at least 3 pages (homepage, post detail, about).",
    jsonMode: true,
  },
  {
    id: "plan-ecom",
    stage: "plan",
    user: "Plan a small e-commerce storefront with product listing, cart, checkout.",
    rubric:
      "Valid JSON with `summary` + `pages`; pages include product listing, cart, checkout; data model implied or stated.",
    jsonMode: true,
  },
  {
    id: "plan-events",
    stage: "plan",
    user: "Plan an events directory with search, event detail, RSVP.",
    rubric: "Valid JSON with `summary` + `pages`; includes search, event detail, RSVP.",
    jsonMode: true,
  },
  {
    id: "plan-faq",
    stage: "plan",
    user: "Plan a customer support FAQ site with categories and search.",
    rubric: "Valid JSON with `summary` + `pages`; mentions categories and search.",
    jsonMode: true,
  },
  {
    id: "plan-dashboard",
    stage: "plan",
    user: "Plan a personal finance dashboard with budgets, transactions, and charts.",
    rubric: "Valid JSON with `summary` + `pages`; mentions budgets, transactions, charts.",
    jsonMode: true,
  },

  // intent — INTENT_CLASSIFIER_SYSTEM returns strict JSON {intent: "converse"|"plan"|"build", confidence: number}.
  {
    id: "intent-build-new",
    stage: "intent",
    user: "I want to build a Pomodoro timer with break notifications.",
    rubric:
      'Valid JSON; `intent` field equals exactly "mutate" because the user explicitly asked to build now.',
    jsonMode: true,
  },
  {
    id: "intent-refine",
    stage: "intent",
    user: "Change the button color to blue.",
    rubric: 'Valid JSON; `intent` field equals exactly "mutate".',
    jsonMode: true,
  },
  {
    id: "intent-question",
    stage: "intent",
    user: "How does the publishing flow work?",
    rubric: 'Valid JSON; `intent` field equals exactly "answer".',
    jsonMode: true,
  },
  {
    id: "intent-meta",
    stage: "intent",
    user: "you misunderstood, I asked the same thing again",
    rubric: 'Valid JSON; `intent` equals exactly "answer" (meta-conversation).',
    jsonMode: true,
  },
  {
    id: "intent-plan",
    stage: "intent",
    user: "Plan me a dashboard before you build anything.",
    rubric: 'Valid JSON; `intent` equals exactly "plan".',
    jsonMode: true,
  },

  // converse — free-form replies, no JSON.
  {
    id: "converse-greeting",
    stage: "converse",
    user: "Hi, what can you build for me?",
    rubric:
      "Friendly and focused; accurately names NabuFlow's app-building capability, invites a concrete idea, contains no code, and makes no unsupported capability claim.",
    jsonMode: false,
  },
  {
    id: "converse-clarify",
    stage: "converse",
    user: "What kinds of apps can NabuFlow help me make?",
    rubric:
      "Answers in plain language with useful app categories, stays focused on NabuFlow, invites one concrete next choice, and contains no code.",
    jsonMode: false,
  },
  {
    id: "converse-confirm",
    stage: "converse",
    user: "I just published my app, what next?",
    rubric:
      "Acknowledges publish; gives one specific next-step suggestion (e.g. custom domain, share URL, iterate).",
    jsonMode: false,
  },
  {
    id: "converse-blocked",
    stage: "converse",
    user: "Show me how to scrape a paywalled news site.",
    rubric:
      "Declines bypassing the paywall, suggests legitimate alternatives such as RSS or an official API, and stays practical without providing evasion steps.",
    jsonMode: false,
  },
  {
    id: "converse-frustrated",
    stage: "converse",
    user: "This is broken AGAIN. The login button doesn't do anything.",
    rubric:
      "Acknowledges feelings without grovelling; asks one diagnostic question OR offers a concrete next step; no excessive apology.",
    jsonMode: false,
  },

  // architect — ARCHITECT_SYSTEM_PROMPT returns JSON {verdict, findings, …}.
  {
    id: "architect-sql",
    stage: "architect",
    user: "Review this build: User wanted a profile lookup. Builder produced:\nconst sql = `SELECT * FROM users WHERE name = '${name}'`;\ndb.query(sql);",
    rubric:
      "Valid JSON with `verdict` field; verdict is 'fail' or 'critical'; `findings` mention SQL injection / parameterised queries.",
    jsonMode: true,
  },
  {
    id: "architect-eval",
    stage: "architect",
    user: "Review: builder shipped `eval(userInput);` in app.js. Decide verdict.",
    rubric:
      "Valid JSON; verdict is 'fail' or 'critical'; findings mention arbitrary code execution / XSS / RCE.",
    jsonMode: true,
  },
  {
    id: "architect-const",
    stage: "architect",
    user: "Review: builder produced `const x = 5; x = 6;`. Decide verdict.",
    rubric: "Valid JSON; verdict is 'fail' (won't run); findings mention reassignment of const.",
    jsonMode: true,
  },
  {
    id: "architect-localstorage-token",
    stage: "architect",
    user: 'Review: builder shipped `localStorage.setItem("session_token", token);`. Decide verdict.',
    rubric:
      "Valid JSON; verdict is 'partial' or 'fail'; findings mention XSS / httpOnly cookie / token storage risk.",
    jsonMode: true,
  },
  {
    id: "architect-fine",
    stage: "architect",
    user: 'USER REQUEST:\nCreate a greet utility that returns "Hello, <name>!".\n\nDIFF SUMMARY:\nFiles added (1): greet.ts\nFiles modified (0): —\nFiles removed (0): —\n\nCOMMANDS RUN:\n- npm test (exit 0)\n\nFILE EXCERPTS:\n--- greet.ts ---\nexport const greet = (name: string) => `Hello, ${name}!`;',
    rubric:
      "Valid JSON; verdict is exactly 'pass'; no critical or high findings. Evidence-backed low findings are allowed by the production Architect verdict contract.",
    jsonMode: true,
  },
];

function getOpenAI(): OpenAI {
  const apiKey = process.env["AI_INTEGRATIONS_OPENAI_API_KEY"];
  const baseURL = process.env["AI_INTEGRATIONS_OPENAI_BASE_URL"];
  if (!apiKey) throw new Error("AI_INTEGRATIONS_OPENAI_API_KEY is not set");
  return new OpenAI({ apiKey, baseURL, timeout: 120_000, maxRetries: 1 });
}

const MODEL = process.env["EVAL_MODEL"] ?? "gpt-5-mini";
const CONCURRENCY = Math.max(1, Number(process.env["EVAL_CONCURRENCY"] ?? "4"));
const MAX_GENERATION_TOKENS = 8_000;
const MAX_JUDGE_TOKENS = 2_000;

async function judgeCandidate(
  client: OpenAI,
  rubric: string,
  candidate: string,
): Promise<{ score: number; reasoning: string }> {
  const messages = [
    {
      role: "system" as const,
      content: `You are a strict evaluation judge. ${promptEvalJudgeInstruction("artifact")} Score 10 = perfect; scores below 6 fail.`,
    },
    {
      role: "user" as const,
      content: `Rubric: ${rubric}\n\nCandidate evidence:\n${candidate}`,
    },
  ];
  for (let attempt = 0; attempt < 2; attempt++) {
    const judge = await client.chat.completions.create({
      model: MODEL,
      response_format: { type: "json_object" },
      messages,
      max_completion_tokens: MAX_JUDGE_TOKENS,
    });
    const parsed = parsePromptEvalJudgeDecision(judge.choices[0]?.message?.content ?? "");
    if (parsed) return parsed;
  }
  throw new Error("prompt_eval_judge_invalid_after_retry");
}

async function runOne(client: OpenAI, fx: Fixture): Promise<FixtureResult> {
  let generationAttempts = 0;
  try {
    let output = "";
    let generationIssue: ReturnType<typeof classifyPromptEvalGeneration> = "empty";
    for (let attempt = 1; attempt <= 2; attempt++) {
      generationAttempts = attempt;
      const gen = await client.chat.completions.create({
        model: MODEL,
        ...(fx.jsonMode ? { response_format: { type: "json_object" as const } } : {}),
        messages: [
          { role: "system", content: STAGE_PROMPT[fx.stage] },
          { role: "user", content: fx.user },
        ],
        max_completion_tokens: MAX_GENERATION_TOKENS,
      });
      output = gen.choices[0]?.message?.content?.trim() ?? "";
      generationIssue = classifyPromptEvalGeneration(output, fx.jsonMode);
      if (generationIssue === null) break;
    }
    if (generationIssue !== null) {
      throw new Error(`prompt_eval_generation_${generationIssue}_after_retry`);
    }

    const evidence = buildPromptEvalCandidateEvidence(output, fx.jsonMode);
    const parsed = await judgeCandidate(client, fx.rubric, evidence.display);
    const score = parsed.score;
    return {
      id: fx.id,
      stage: fx.stage,
      score,
      passed: score >= 6,
      reasoning: parsed.reasoning,
      outputPreview: output.slice(0, 400),
      outputChars: evidence.outputChars,
      outputSha256: evidence.outputSha256,
      candidateEvidenceChars: evidence.evidenceChars,
      jsonValid: evidence.jsonValid,
      generationAttempts,
    };
  } catch (err) {
    return {
      id: fx.id,
      stage: fx.stage,
      score: 0,
      passed: false,
      reasoning: "",
      outputPreview: "",
      outputChars: 0,
      outputSha256: "0".repeat(64),
      candidateEvidenceChars: 0,
      jsonValid: fx.jsonMode ? false : null,
      generationAttempts,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function runAll(): Promise<RunRecord> {
  const client = getOpenAI();
  const startedAt = new Date().toISOString();
  const results: FixtureResult[] = new Array(FIXTURES.length);

  let cursor = 0;
  const workers: Promise<void>[] = [];
  for (let w = 0; w < CONCURRENCY; w++) {
    workers.push(
      (async () => {
        while (true) {
          const i = cursor++;
          if (i >= FIXTURES.length) return;
          const fx = FIXTURES[i]!;
          process.stdout.write(`  [${i + 1}/${FIXTURES.length}] ${fx.id} … `);
          const r = await runOne(client, fx);
          results[i] = r;
          process.stdout.write(
            `${r.error ? "ERROR" : r.passed ? "PASS" : "FAIL"} (${r.score}/10)\n`,
          );
        }
      })(),
    );
  }
  await Promise.all(workers);

  const perStage: RunRecord["perStage"] = {
    build: { passed: 0, failed: 0, avgScore: 0 },
    refine: { passed: 0, failed: 0, avgScore: 0 },
    plan: { passed: 0, failed: 0, avgScore: 0 },
    intent: { passed: 0, failed: 0, avgScore: 0 },
    converse: { passed: 0, failed: 0, avgScore: 0 },
    architect: { passed: 0, failed: 0, avgScore: 0 },
  };
  const stageScores: Record<Stage, number[]> = {
    build: [],
    refine: [],
    plan: [],
    intent: [],
    converse: [],
    architect: [],
  };
  for (const r of results) {
    if (r.passed) perStage[r.stage].passed++;
    else perStage[r.stage].failed++;
    stageScores[r.stage].push(r.score);
  }
  for (const s of Object.keys(stageScores) as Stage[]) {
    const arr = stageScores[s];
    perStage[s].avgScore = arr.length === 0 ? 0 : arr.reduce((a, b) => a + b, 0) / arr.length;
  }

  return {
    startedAt,
    finishedAt: new Date().toISOString(),
    model: MODEL,
    totalFixtures: results.length,
    passed: results.filter((r) => r.passed).length,
    failed: results.filter((r) => !r.passed && !r.error).length,
    errored: results.filter((r) => !!r.error).length,
    perStage,
    results,
  };
}

function compare(latest: RunRecord, baseline: RunRecord | null): ComparisonRecord {
  if (!baseline) {
    return { winners: [], losers: [], ties: [], totalDeltaScore: 0, regressionRatio: 0 };
  }
  const byId = new Map(baseline.results.map((r) => [r.id, r]));
  const winners: ComparisonRecord["winners"] = [];
  const losers: ComparisonRecord["losers"] = [];
  const ties: string[] = [];
  let totalDelta = 0;
  for (const r of latest.results) {
    const prev = byId.get(r.id);
    if (!prev) continue;
    const delta = r.score - prev.score;
    totalDelta += delta;
    if (delta >= 1) winners.push({ id: r.id, from: prev.score, to: r.score });
    else if (delta <= -1) losers.push({ id: r.id, from: prev.score, to: r.score });
    else ties.push(r.id);
  }
  return {
    winners,
    losers,
    ties,
    totalDeltaScore: totalDelta,
    regressionRatio: losers.length / Math.max(1, latest.results.length),
  };
}

async function main() {
  const updateBaseline = process.argv.includes("--update-baseline");
  await mkdir(RESULTS_DIR, { recursive: true });

  console.log(
    `Running ${FIXTURES.length} eval fixtures against the real production prompts via ${MODEL} (concurrency=${CONCURRENCY})…`,
  );
  const latest = await runAll();

  // eslint-disable-next-line no-useless-assignment
  let baseline: RunRecord | null = null;
  try {
    baseline = JSON.parse(await readFile(BASELINE_PATH, "utf8")) as RunRecord;
  } catch {
    baseline = null;
  }
  // Task #545: in CI we require an explicit committed baseline so the
  // regression gate is actually enforceable. Without one, any silent prompt
  // regression would just become the new baseline and pass.
  if (!baseline && !updateBaseline && process.env["CI"] === "true") {
    console.error(
      "\nFAIL: no baseline.json found in scripts/eval-results/. Commit a baseline (run locally with --update-baseline) before relying on this gate in CI.",
    );
    process.exit(1);
  }
  const comparison = compare(latest, baseline);

  const full = { ...latest, comparison };
  await writeFile(LATEST_PATH, JSON.stringify(full, null, 2), "utf8");

  if (!baseline || updateBaseline) {
    await writeFile(BASELINE_PATH, JSON.stringify(latest, null, 2), "utf8");
    console.log(`\nWrote baseline.json (${baseline ? "updated" : "first run"}).`);
  }

  console.log(`\n=== Eval summary ===`);
  console.log(`Pass: ${latest.passed}/${latest.totalFixtures}`);
  console.log(`Fail: ${latest.failed}    Error: ${latest.errored}`);
  for (const s of Object.keys(latest.perStage) as Stage[]) {
    const ps = latest.perStage[s];
    console.log(
      `  ${s.padEnd(10)} pass=${ps.passed} fail=${ps.failed}  avg=${ps.avgScore.toFixed(2)}`,
    );
  }
  if (baseline) {
    console.log(
      `\nDeltas vs baseline: +${comparison.winners.length} win · ${comparison.ties.length} tie · -${comparison.losers.length} lose  (Δscore=${comparison.totalDeltaScore})`,
    );
    for (const l of comparison.losers) {
      console.log(`  REGRESSED: ${l.id}  ${l.from} → ${l.to}`);
    }
    if (comparison.regressionRatio > REGRESSION_THRESHOLD && !updateBaseline) {
      console.error(
        `\nFAIL: regression ${(comparison.regressionRatio * 100).toFixed(1)}% > threshold ${(REGRESSION_THRESHOLD * 100).toFixed(0)}%`,
      );
      process.exit(1);
    }
  }
  console.log(`\nLatest results: ${LATEST_PATH}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
