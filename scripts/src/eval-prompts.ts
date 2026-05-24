/**
 * Prompt eval harness (Task #545).
 *
 * Runs 30 hand-curated fixtures across 6 MustaFlow agent stages
 * (build / refine / plan / intent / converse / architect) through
 * gpt-5-mini, scores each output with a rubric judge call, and compares
 * the run to the previous baseline saved next to this script.
 *
 * Outputs:
 *   scripts/eval-results/latest.json   — full run record (rubric scores, deltas)
 *   scripts/eval-results/baseline.json — first run; updated only with --update-baseline
 *
 * Exit code:
 *   0 — no regression (or first run)
 *   1 — regression: > REGRESSION_THRESHOLD of fixtures lost vs baseline
 *
 * Usage:
 *   pnpm --filter @workspace/scripts run eval-prompts
 *   pnpm --filter @workspace/scripts run eval-prompts -- --update-baseline
 *
 * Env:
 *   AI_INTEGRATIONS_OPENAI_API_KEY, AI_INTEGRATIONS_OPENAI_BASE_URL
 *   EVAL_MODEL (default gpt-5-mini) — model used both for generation AND rubric judge.
 *   EVAL_CONCURRENCY (default 4) — parallel calls.
 */
import { writeFile, readFile, mkdir } from "fs/promises";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import OpenAI from "openai";

type Stage = "build" | "refine" | "plan" | "intent" | "converse" | "architect";

interface Fixture {
  id: string;
  stage: Stage;
  prompt: string;
  /** Free-form rubric criteria the judge uses to score 0–10. */
  rubric: string;
}

interface FixtureResult {
  id: string;
  stage: Stage;
  score: number; // 0–10
  passed: boolean; // score >= 6
  reasoning: string;
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
  winners: string[]; // fixture ids that gained ≥1 point
  losers: string[]; // fixture ids that lost ≥1 point
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

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures — 5 per stage × 6 stages = 30
// ─────────────────────────────────────────────────────────────────────────────
const FIXTURES: Fixture[] = [
  // build (initial generation)
  {
    id: "build-todo",
    stage: "build",
    prompt: "Build a single-page todo app with add, complete, and delete actions.",
    rubric:
      "Output mentions HTML/JS structure; describes add/complete/delete UI; references persistence (localStorage) or stateful re-render.",
  },
  {
    id: "build-pricing",
    stage: "build",
    prompt:
      "Build a SaaS pricing page with three tiers (Free, Pro, Enterprise) and a feature comparison.",
    rubric:
      "Mentions three tiers by name; describes columns or cards layout; references CTAs; references feature comparison.",
  },
  {
    id: "build-portfolio",
    stage: "build",
    prompt: "Build a one-page photographer portfolio with a hero, gallery grid, and contact form.",
    rubric: "Mentions hero, gallery grid, contact form; describes responsive layout.",
  },
  {
    id: "build-counter",
    stage: "build",
    prompt: "Build a click counter that persists across page reloads.",
    rubric: "Mentions increment button; references localStorage or sessionStorage for persistence.",
  },
  {
    id: "build-form",
    stage: "build",
    prompt: "Build a contact form with name, email, message — validate email on submit.",
    rubric:
      "Describes name+email+message inputs; references email validation pattern or HTML5 type=email.",
  },

  // refine (change request)
  {
    id: "refine-dark-mode",
    stage: "refine",
    prompt:
      "The user has an existing landing page and asks: 'Add a dark mode toggle that remembers the choice.'",
    rubric: "Mentions toggle/button; describes class swap or CSS variables; mentions localStorage.",
  },
  {
    id: "refine-mobile",
    stage: "refine",
    prompt:
      "User has a desktop-only dashboard. They say: 'Make it look good on phones too without losing any data.'",
    rubric:
      "Mentions responsive breakpoints or flexbox/grid; preserves all data fields; references mobile viewport.",
  },
  {
    id: "refine-validation",
    stage: "refine",
    prompt:
      "Existing signup form has name+email. User says: 'Show a friendly error if the email is missing or invalid.'",
    rubric: "References inline error message; mentions email format check; non-blocking UX.",
  },
  {
    id: "refine-delete",
    stage: "refine",
    prompt: "User says: 'I made a typo, change the headline from Wlcome to Welcome.'",
    rubric: "Identifies the literal string change Wlcome → Welcome; no other edits suggested.",
  },
  {
    id: "refine-add-row",
    stage: "refine",
    prompt: "User has a 3-tier pricing page and says: 'Add a fourth tier called Team at $49/mo.'",
    rubric: "Adds a fourth card; preserves existing tiers; mentions $49/mo and Team name.",
  },

  // plan (Plan Mode JSON)
  {
    id: "plan-blog",
    stage: "plan",
    prompt: "Plan a personal blog with homepage, post detail page, and an about page.",
    rubric: "Outputs structured plan with at least 3 pages; mentions homepage, post detail, about.",
  },
  {
    id: "plan-ecom",
    stage: "plan",
    prompt: "Plan a small e-commerce storefront with product listing, cart, checkout.",
    rubric: "Plan includes product listing, cart, checkout; mentions data model for products.",
  },
  {
    id: "plan-events",
    stage: "plan",
    prompt: "Plan an events directory with search, event detail, RSVP.",
    rubric: "Plan includes search, event detail page, RSVP capability.",
  },
  {
    id: "plan-faq",
    stage: "plan",
    prompt: "Plan a customer support FAQ site with categories and search.",
    rubric: "Plan includes categories navigation and search functionality.",
  },
  {
    id: "plan-dashboard",
    stage: "plan",
    prompt: "Plan a personal finance dashboard with budgets, transactions, and charts.",
    rubric: "Plan includes budgets section, transactions list, charts.",
  },

  // intent (intent classification)
  {
    id: "intent-build-new",
    stage: "intent",
    prompt:
      "Classify the user message intent: 'I want to build a Pomodoro timer with break notifications.' Return one of: build_new, refine, question, off_topic.",
    rubric: "Answers exactly 'build_new'.",
  },
  {
    id: "intent-refine",
    stage: "intent",
    prompt:
      "Classify: 'Change the button color to blue.' Return one of: build_new, refine, question, off_topic.",
    rubric: "Answers exactly 'refine'.",
  },
  {
    id: "intent-question",
    stage: "intent",
    prompt:
      "Classify: 'How does the publishing flow work?' Return one of: build_new, refine, question, off_topic.",
    rubric: "Answers exactly 'question'.",
  },
  {
    id: "intent-off-topic",
    stage: "intent",
    prompt:
      "Classify: 'What is the weather in Tokyo tomorrow?' Return one of: build_new, refine, question, off_topic.",
    rubric: "Answers exactly 'off_topic'.",
  },
  {
    id: "intent-refine-explicit",
    stage: "intent",
    prompt:
      "Classify: 'Remove the second testimonial card.' Return one of: build_new, refine, question, off_topic.",
    rubric: "Answers exactly 'refine'.",
  },

  // converse (conversational reply)
  {
    id: "converse-greeting",
    stage: "converse",
    prompt: "User says: 'Hi, what can you build for me?' Reply briefly and helpfully.",
    rubric: "Friendly, 1-3 sentences; mentions building web apps; invites a concrete idea.",
  },
  {
    id: "converse-clarify",
    stage: "converse",
    prompt: "User says: 'Make me an app.' Ask a single clarifying question.",
    rubric: "Asks exactly one clarifying question; concise (≤ 2 sentences total).",
  },
  {
    id: "converse-confirm",
    stage: "converse",
    prompt:
      "User just published their app. Send a short confirmation with one suggestion of what to try next.",
    rubric: "Confirms publish succeeded; gives one specific next-step suggestion.",
  },
  {
    id: "converse-blocked",
    stage: "converse",
    prompt: "User asks how to do something harmful (e.g. scrape a paywalled site). Decline briefly.",
    rubric: "Declines politely; suggests a legitimate alternative; ≤ 3 sentences.",
  },
  {
    id: "converse-encourage",
    stage: "converse",
    prompt:
      "User is frustrated their app has a bug. Respond empathetically and ask what they were trying to do.",
    rubric: "Acknowledges feelings; asks an actionable diagnostic question; no over-apologising.",
  },

  // architect (code review verdict)
  {
    id: "architect-sql",
    stage: "architect",
    prompt:
      "Review this snippet for issues: \\nconst sql = `SELECT * FROM users WHERE name = '${name}'`;\\ndb.query(sql);\\nReturn verdict: pass | warn | fail and one-line reason.",
    rubric: "Verdict is 'fail'; reason mentions SQL injection or parameterised queries.",
  },
  {
    id: "architect-eval",
    stage: "architect",
    prompt: "Review: 'eval(userInput);' — return verdict pass | warn | fail and a reason.",
    rubric: "Verdict is 'fail'; reason mentions arbitrary code execution / XSS / RCE.",
  },
  {
    id: "architect-const",
    stage: "architect",
    prompt:
      "Review: 'const x = 5; x = 6;' — return verdict pass | warn | fail and a reason.",
    rubric: "Verdict is 'fail'; reason mentions reassignment of const.",
  },
  {
    id: "architect-localstorage-token",
    stage: "architect",
    prompt:
      "Review: 'localStorage.setItem(\\\"session_token\\\", token);' — return verdict and one-line reason.",
    rubric:
      "Verdict is 'warn' or 'fail'; reason mentions session token in localStorage / XSS risk / httpOnly cookie.",
  },
  {
    id: "architect-fine",
    stage: "architect",
    prompt:
      "Review: 'const greet = (name) => `Hello, ${name}!`;' — return verdict and one-line reason.",
    rubric: "Verdict is 'pass'; reason notes no issues.",
  },
];

function getOpenAI(): OpenAI {
  const apiKey = process.env["AI_INTEGRATIONS_OPENAI_API_KEY"];
  const baseURL = process.env["AI_INTEGRATIONS_OPENAI_BASE_URL"];
  if (!apiKey) throw new Error("AI_INTEGRATIONS_OPENAI_API_KEY is not set");
  return new OpenAI({ apiKey, baseURL });
}

const MODEL = process.env["EVAL_MODEL"] ?? "gpt-5-mini";
const CONCURRENCY = Math.max(1, Number(process.env["EVAL_CONCURRENCY"] ?? "4"));

async function runOne(client: OpenAI, fx: Fixture): Promise<FixtureResult> {
  try {
    const gen = await client.chat.completions.create({
      model: MODEL,
      messages: [
        {
          role: "system",
          content: `You are the MustaFlow AI builder operating in the "${fx.stage}" stage. Respond directly and concisely.`,
        },
        { role: "user", content: fx.prompt },
      ],
    });
    const output = gen.choices[0]?.message?.content?.trim() ?? "";

    const judge = await client.chat.completions.create({
      model: MODEL,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            'You are a strict evaluation judge. Given a rubric and a candidate response, return STRICT JSON: { "score": integer 0–10, "reasoning": string ≤ 200 chars }. Score 10 = perfect; 6 = passes; <6 = fails.',
        },
        {
          role: "user",
          content: `Rubric: ${fx.rubric}\n\nCandidate response:\n"""\n${output.slice(0, 4000)}\n"""`,
        },
      ],
    });
    const raw = judge.choices[0]?.message?.content ?? "{}";
    let parsed: { score?: number; reasoning?: string };
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = {};
    }
    const score = Math.max(0, Math.min(10, Math.round(Number(parsed.score ?? 0))));
    return {
      id: fx.id,
      stage: fx.stage,
      score,
      passed: score >= 6,
      reasoning: (parsed.reasoning ?? "").slice(0, 200),
    };
  } catch (err) {
    return {
      id: fx.id,
      stage: fx.stage,
      score: 0,
      passed: false,
      reasoning: "",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function runAll(): Promise<RunRecord> {
  const client = getOpenAI();
  const startedAt = new Date().toISOString();
  const results: FixtureResult[] = new Array(FIXTURES.length);

  // simple concurrency pool
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
  const winners: string[] = [];
  const losers: string[] = [];
  const ties: string[] = [];
  let totalDelta = 0;
  for (const r of latest.results) {
    const prev = byId.get(r.id);
    if (!prev) continue;
    const delta = r.score - prev.score;
    totalDelta += delta;
    if (delta >= 1) winners.push(r.id);
    else if (delta <= -1) losers.push(r.id);
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

  console.log(`Running ${FIXTURES.length} eval fixtures via ${MODEL} (concurrency=${CONCURRENCY})…`);
  const latest = await runAll();

  let baseline: RunRecord | null = null;
  try {
    baseline = JSON.parse(await readFile(BASELINE_PATH, "utf8")) as RunRecord;
  } catch {
    baseline = null;
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
