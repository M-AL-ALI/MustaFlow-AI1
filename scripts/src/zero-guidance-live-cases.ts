import { sha256, stableJson } from "./zero-guidance-manifest";

export interface ZeroGuidanceLiveCase {
  id: string;
  coverageId: string;
  mode: "runtime-prompt" | "source-audit";
  sourceIds: string[];
  user: string;
  rubric: string;
  jsonMode: boolean;
}

export const ZERO_GUIDANCE_LIVE_CASES: ZeroGuidanceLiveCase[] = [
  {
    id: "build-generation-representative",
    coverageId: "live:build-generation",
    mode: "runtime-prompt",
    sourceIds: ["prompt:builder:BUILD_SYSTEM_PROMPT"],
    user: "Build a one-page accessible event landing page with a schedule and registration form.",
    rubric:
      "Returns the prompt's required structured source shape, includes real page markup, schedule content, a registration form, and accessible labels.",
    jsonMode: true,
  },
  {
    id: "refinement-representative",
    coverageId: "live:refinement",
    mode: "runtime-prompt",
    sourceIds: ["prompt:builder:REFINE_SYSTEM_PROMPT"],
    user: 'Project: "Event demo" (kind: web).\n\nCURRENT PROJECT FILES:\n--- index.html (text/html) ---\n<!doctype html><html><body><main><h1>Community Day</h1><section id="schedule"><h2>Schedule</h2><p>10:00 Welcome</p></section></main></body></html>\n\nApply this change: Add a high-contrast toggle without removing or rewriting unrelated sections.',
    rubric:
      "Returns the refinement shape, changes only affected files, preserves the schedule, and implements a usable high-contrast toggle.",
    jsonMode: true,
  },
  {
    id: "planning-representative",
    coverageId: "live:planning",
    mode: "runtime-prompt",
    sourceIds: ["prompt:builder:PLAN_SYSTEM_PROMPT"],
    user: "Plan a volunteer coordination portal with shifts, signup, reminders, and an organizer view.",
    rubric:
      "Returns the declared plan shape, covers all requested flows, names pages and data needs, and does not generate implementation code.",
    jsonMode: true,
  },
  {
    id: "intent-representative",
    coverageId: "live:intent",
    mode: "runtime-prompt",
    sourceIds: ["prompt:builder:INTENT_CLASSIFIER_SYSTEM"],
    user: "Plan the volunteer portal first; do not build it yet.",
    rubric:
      "Returns the classifier's strict shape and selects plan with a bounded confidence value.",
    jsonMode: true,
  },
  {
    id: "conversation-representative",
    coverageId: "live:conversation",
    mode: "runtime-prompt",
    sourceIds: ["prompt:builder:EXPLAIN_SYSTEM_PROMPT"],
    user: "Explain in plain language what a successful publish changes and what it does not change.",
    rubric:
      "Explains the concept clearly, distinguishes deployed state from source state, and does not invent the user's deployment status.",
    jsonMode: false,
  },
  {
    id: "review-representative",
    coverageId: "live:review",
    mode: "runtime-prompt",
    sourceIds: ["prompt:architect:ARCHITECT_SYSTEM_PROMPT"],
    user: 'Review this complete source file; it has no omitted tail or truncation marker:\n```ts\nexport async function findUser(db: { query(sql: string, values: unknown[]): Promise<unknown> }, id: string) {\n  return db.query("SELECT id, name FROM users WHERE id = $1", [id]);\n}\n```',
    rubric:
      "Returns the declared review shape, treats the source as complete, and does not invent missing-tail findings.",
    jsonMode: true,
  },
  {
    id: "developer-intent-representative",
    coverageId: "live:developer-intent",
    mode: "runtime-prompt",
    sourceIds: ["prompt:builder:DEBUG_SYSTEM_PROMPT"],
    user: "A submit button works once and then remains disabled. Identify the root cause before proposing a patch. Complete source:\n```tsx\nfunction ContactForm() {\n  const [submitting, setSubmitting] = useState(false);\n  async function submit() {\n    setSubmitting(true);\n    await sendContact();\n  }\n  return <button disabled={submitting} onClick={submit}>Send</button>;\n}\n```\nThe request resolves successfully and the component stays mounted.",
    rubric:
      "Separates evidence from hypothesis and proposes a minimal, testable diagnostic or fix.",
    jsonMode: false,
  },
  {
    id: "repair-representative",
    coverageId: "live:repair",
    mode: "runtime-prompt",
    sourceIds: ["prompt:builder:BROWSER_FIX_SYSTEM_PROMPT"],
    user: 'The browser test proves app.js throws at `document.querySelector("#result").textContent = "Sent"` because that lookup is null. The complete HTML contains `<p id="status"></p>` and no element with id `result`. Return only the minimum patch that preserves every other behavior.',
    rubric: "Produces a minimal evidence-bound correction without redesigning unrelated behavior.",
    jsonMode: true,
  },
  {
    id: "test-planning-representative",
    coverageId: "live:test-planning",
    mode: "runtime-prompt",
    sourceIds: ["prompt:builder:TEST_GENERATION_SYSTEM_PROMPT"],
    user: 'Project description: Contact form with invalid-input feedback, successful submission, and an error retry.\n\nHTML content:\n<form id="contact"><input name="email" type="email" required><button type="submit">Send</button><p id="error" hidden>Check your email</p><p id="success" hidden>Message sent</p><button id="retry" hidden>Try again</button></form>',
    rubric: "Returns a concise plan that covers the three requested user-visible outcomes.",
    jsonMode: true,
  },
  {
    id: "agent-loop-contract",
    coverageId: "live:agent-loop",
    mode: "source-audit",
    sourceIds: ["assembler:agent-loop:build-system-prompt"],
    user: "State the loop's completion, tool-use, and bounded-execution obligations as a short checklist.",
    rubric:
      "Accurately identifies the source's completion rules, tool discipline, and named execution bounds without adding capabilities.",
    jsonMode: false,
  },
  {
    id: "jobs-context-contract",
    coverageId: "live:jobs-context",
    mode: "source-audit",
    sourceIds: ["assembler:jobs:knowledge-context", "assembler:jobs:run-job"],
    user: "Explain the precedence and safety constraints applied when prior lessons and project context enter a build.",
    rubric:
      "Distinguishes retrieved knowledge from current project evidence and preserves the coordinator's stack-specific constraints.",
    jsonMode: false,
  },
  {
    id: "message-routing-contract",
    coverageId: "live:message-routing",
    mode: "source-audit",
    sourceIds: ["assembler:messages:routing"],
    user: "Describe how a developer-intent request selects its prompt family and retains project-scoped context.",
    rubric:
      "Names the routing decision and project/context handoff without claiming client-only enforcement.",
    jsonMode: false,
  },
  {
    id: "reviewer-context-contract",
    coverageId: "live:reviewer-context",
    mode: "source-audit",
    sourceIds: ["assembler:reviewer:file-context", "assembler:reviewer:workspace-context"],
    user: "Explain how review files are selected and how a bounded excerpt communicates truncation.",
    rubric:
      "Identifies prioritization, file/count budgets, and the explicit truncation marker; never treats budget exhaustion as EOF.",
    jsonMode: false,
  },
  {
    id: "skill-guidance-contract",
    coverageId: "live:skill-guidance",
    mode: "source-audit",
    sourceIds: ["skill:react-vite:instructions", "assembler:skills:target-content"],
    user: "Explain when this skill is loaded and which React/Vite guidance a matching build must retain.",
    rubric:
      "Uses the target-aware load path and accurately summarizes the representative skill's instructions.",
    jsonMode: false,
  },
  {
    id: "blueprint-guidance-contract",
    coverageId: "live:blueprint-guidance",
    mode: "source-audit",
    sourceIds: ["blueprint:db-neon:document", "assembler:blueprints:install"],
    user: "Explain what the representative database blueprint installs and how installation remains declared and idempotent.",
    rubric:
      "Matches the blueprint document and loader contract without inventing a human credential handoff.",
    jsonMode: false,
  },
  {
    id: "sealed-eligibility-contract",
    coverageId: "live:sealed-eligibility",
    mode: "source-audit",
    sourceIds: [
      "skill:postgres-drizzle:eligibility",
      "blueprint:payments-stripe:eligibility",
      "assembler:eligibility:generated-output",
    ],
    user: "Classify what makes generated output eligible or ineligible for the sealed target and how a gap is reported.",
    rubric:
      "Uses content-derived eligibility, capability coverage, and typed gap reasons; rejects raw credentials and uncontrolled runtime network access.",
    jsonMode: false,
  },
  {
    id: "sealed-generation-contract",
    coverageId: "live:sealed-generation",
    mode: "source-audit",
    sourceIds: ["guidance:sealed-node:prompt-extension", "assembler:sealed-node:prepare-source"],
    user: "Summarize the sealed Node runtime contract for capabilities, dependencies, port, health, and credentials.",
    rubric:
      "Requires capabilities instead of tenant credentials, dependency-complete output, the declared runtime port/health contract, and no tenant install step.",
    jsonMode: false,
  },
  {
    id: "intent-admission-contract",
    coverageId: "live:intent-admission",
    mode: "source-audit",
    sourceIds: [
      "contract:intent-admission:governor",
      "contract:intent-admission:judge",
      "contract:intent-admission:routing",
    ],
    user: "Explain what must exist before Zero may mutate a project, and what happens when the user's request is observational or ambiguous.",
    rubric:
      "Requires a typed request-bound intent receipt before mutation, keeps observe and answer requests out of the write path, and routes ambiguity to one focused clarification rather than guessing.",
    jsonMode: false,
  },
  {
    id: "terminal-honesty-contract",
    coverageId: "live:terminal-honesty",
    mode: "source-audit",
    sourceIds: ["contract:terminal-honesty:parser", "contract:terminal-honesty:presenter"],
    user: "State exactly when Zero may tell a person that a change was applied, and how interruption, failure, and changed-with-issues are described.",
    rubric:
      "Says mutation success requires version and diff evidence, preserves interrupted and failed outcomes, distinguishes changed-with-issues, and never converts missing evidence into successful past tense.",
    jsonMode: false,
  },
  {
    id: "snapshot-observe-contract",
    coverageId: "live:snapshot-observe",
    mode: "source-audit",
    sourceIds: ["contract:snapshot-observe:client", "contract:snapshot-observe:server"],
    user: "Explain what Snapshot-to-Zero sends, which intent path receives it, whether it writes project source or versions, and whether a consumed grant followed by capture failure is ever retried invisibly.",
    rubric:
      "Identifies captured image bytes and the preview class, keeps the path observe-only with zero project writes, and says a consumed grant followed by capture failure is reported unavailable without an invisible retry or mutation.",
    jsonMode: false,
  },
  {
    id: "workspace-readiness-contract",
    coverageId: "live:workspace-readiness",
    mode: "source-audit",
    sourceIds: ["contract:workspace-readiness:deriver", "contract:workspace-readiness:presenter"],
    user: "Explain how Zero decides whether a workspace is ready and what it says when validation, preview, or publish evidence is missing or failed.",
    rubric:
      "Binds readiness to the exact task/version/revision, requires the complete evidence set for ready, fails closed to blocked or unknown, and makes ready wording unreachable when validation, preview, or publish evidence is unresolved.",
    jsonMode: false,
  },
  {
    id: "preview-handoff-contract",
    coverageId: "live:preview-handoff",
    mode: "source-audit",
    sourceIds: ["contract:preview-handoff:server", "contract:preview-handoff:client"],
    user: "Explain how the workspace chooses a preview address and why the embedded preview must not claim availability from a display-state guess.",
    rubric:
      "Derives access from server configuration and runtime truth, distinguishes unavailable/direct/gateway states, and requires an authenticated private handoff instead of inventing a reachable URL from client display state.",
    jsonMode: false,
  },
];

export const ZERO_GUIDANCE_FIXTURE_SET_SHA256 = sha256(stableJson(ZERO_GUIDANCE_LIVE_CASES));
