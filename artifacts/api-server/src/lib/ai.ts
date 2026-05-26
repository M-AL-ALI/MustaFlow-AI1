import { logger } from "./logger";

export type AgentMode = "lite" | "eco" | "power" | "pro";

// Default openai model per agent mode — used when the per-stage env var
// resolves to openai (or is unset). Multi-provider routing lives in
// ./ai-providers.ts.
const MODEL_FOR_MODE: Record<AgentMode, string> = {
  lite: "gpt-5-nano",
  eco: "gpt-5-mini",
  power: "gpt-5.4",
  pro: "gpt-5.4",
};

// Imported lazily to avoid a circular dep with ai-providers.ts (which
// imports AgentMode from this file).
async function callChat(
  stage: "converse" | "plan",
  agentMode: AgentMode,
  openaiDefault: string,
  body: {
    messages: import("openai/resources/chat/completions").ChatCompletionMessageParam[];
    response_format?: { type: "json_object" } | { type: "text" };
    max_completion_tokens?: number;
  },
) {
  const { createChatCompletion, resolveStageProvider } = await import("./ai-providers");
  // Pass the legacy openaiDefault as the override — env model wins, otherwise
  // we keep the historical OpenAI default for this stage.
  const { provider, model } = resolveStageProvider(stage, agentMode, openaiDefault);
  return createChatCompletion({
    provider,
    model,
    ...body,
  });
}

const SYSTEM_PROMPT = `You are MustaFlow AI, a friendly, focused AI app-building assistant. You help users plan, design, and build web, iOS, and Android apps. You are concise, encouraging, and never use emojis.

Adaptive tone: if the message contains code blocks, file extensions (.js/.ts/.py/.go/.tsx), stack-trace keywords (TypeError, Traceback, at Object, ReferenceError, Exception), or technical terminology — respond with precise technical language, exact names, and concrete examples. Otherwise use plain, accessible language.

When the user describes an app idea or a change:
- Restate the goal in one sentence so they know you understood.
- Recommend a concrete next step.
- If something is ambiguous, ask one focused question.
- Keep replies tight (under 180 words unless the user asks for detail).
- Never invent file changes you have not actually performed. The runtime that applies code changes is being built; for now, describe what you would do.`;

const PLAN_SYSTEM_PROMPT = `${SYSTEM_PROMPT}

You are in PLAN MODE. Do not pretend to make changes. Produce a structured plan as STRICT JSON only (no prose, no markdown fences) matching this shape:
{
  "summary": string,
  "goal": string,
  "approach": string,
  "pages": string[],
  "backend": string[],
  "database": string[],
  "integrations": string[],
  "keysNeeded": string[],
  "filesAffected": string[],
  "risks": string[],
  "testPlan": string[]
}
Be specific but realistic. If a section does not apply, return an empty array.`;

export interface ChatHistoryItem {
  role: "user" | "assistant" | "system";
  content: string;
}

export async function generateAssistantReply(
  projectName: string,
  projectKind: string,
  history: ChatHistoryItem[],
  userContent: string,
  agentMode: AgentMode,
): Promise<string> {
  const model = MODEL_FOR_MODE[agentMode] ?? MODEL_FOR_MODE.eco;
  const messages = [
    { role: "system" as const, content: SYSTEM_PROMPT },
    {
      role: "system" as const,
      content: `Current project: "${projectName}" (kind: ${projectKind}). Agent mode: ${agentMode}.`,
    },
    ...history.map((m) => ({ role: m.role, content: m.content })),
    { role: "user" as const, content: userContent },
  ];

  try {
    const response = await callChat("converse", agentMode, model, {
      max_completion_tokens: 8192,
      messages,
    });
    return (
      response.choices[0]?.message?.content?.trim() ??
      "I'm here. Tell me what you'd like to build next."
    );
  } catch (err) {
    logger.error({ err }, "AI chat completion failed");
    return "I had trouble reaching the AI service just now. Please try again in a moment.";
  }
}

export interface PlanResult {
  text: string;
  plan: Record<string, unknown> | null;
}

export async function generatePlan(
  projectName: string,
  projectKind: string,
  history: ChatHistoryItem[],
  userContent: string,
  agentMode: AgentMode,
): Promise<PlanResult> {
  const model = MODEL_FOR_MODE[agentMode] ?? MODEL_FOR_MODE.eco;
  const messages = [
    { role: "system" as const, content: PLAN_SYSTEM_PROMPT },
    {
      role: "system" as const,
      content: `Current project: "${projectName}" (kind: ${projectKind}).`,
    },
    ...history.map((m) => ({ role: m.role, content: m.content })),
    { role: "user" as const, content: userContent },
  ];

  try {
    const response = await callChat("plan", agentMode, model, {
      max_completion_tokens: 8192,
      messages,
      response_format: { type: "json_object" },
    });
    const raw = response.choices[0]?.message?.content?.trim() ?? "{}";
    let plan: Record<string, unknown> | null = null;
    try {
      plan = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      plan = null;
    }
    const summary =
      typeof plan?.summary === "string"
        ? plan.summary
        : "Here's a plan. Review it and choose how to proceed.";
    return { text: summary, plan };
  } catch (err) {
    logger.error({ err }, "AI plan generation failed");
    return {
      text: "I had trouble generating a plan just now. Please try again in a moment.",
      plan: null,
    };
  }
}

export function buildInitialAssistantMessage(projectName: string, initialPrompt: string): string {
  return `Welcome to MustaFlow AI. I've spun up "${projectName}" for you. Here's what I heard:\n\n"${initialPrompt.trim()}"\n\nWhen you're ready, send me a message describing the first thing you want to see, or toggle Plan Mode and I'll lay out a full build plan for your approval.`;
}

export type StackId =
  | "static-html"
  | "react-vite"
  | "node-api"
  | "mobile-cross"
  | "python-flask"
  | "python-fastapi"
  | "go-gin"
  | "slides"
  | "animation"
  | "automation";

/**
 * Keyword signals that strongly suggest a slide-deck / presentation output.
 * Checked before backend/react signals so a "pitch deck" doesn't accidentally
 * get classified as a React SPA.
 */
const SLIDES_SIGNALS = [
  "slide deck",
  "slide show",
  "slideshow",
  "presentation",
  "pitch deck",
  "pitch presentation",
  "keynote",
  "powerpoint",
  "slides",
  "deck",
  "slide",
];

/**
 * Keyword signals that strongly suggest an animated / motion-graphics output.
 */
const ANIMATION_SIGNALS = [
  "animation",
  "animated",
  "animate",
  "motion graphic",
  "motion design",
  "animated explainer",
  "product explainer",
  "explainer animation",
  "framer motion",
  "gsap animation",
  "lottie",
  "kinetic typography",
];

/**
 * Keyword signals that strongly suggest an automation / script output.
 */
const AUTOMATION_SIGNALS = [
  "automation",
  "automate",
  "cron job",
  "cron script",
  "scheduled job",
  "scheduled report",
  "scheduled task",
  "email csv",
  "email report",
  "batch script",
  "data pipeline",
  "etl script",
  "node script",
  "weekly report",
  "daily report",
  "recurring task",
];

/**
 * Keyword signals that strongly suggest a native mobile app is needed.
 * Checked FIRST — mobile intent overrides all web stack choices.
 */
const MOBILE_SIGNALS = [
  "mobile app",
  "ios app",
  "android app",
  "iphone app",
  "ipad app",
  "phone app",
  "native app",
  "expo",
  "react native",
  "app store",
  "play store",
  "push notification",
  "camera",
  "gps",
  "geolocation",
  "maps",
  "location",
  "swipe",
  "gestures",
  "haptic",
  "offline mode",
  "mobile",
  "smartphone",
  "tablet app",
  "download on",
  "install on phone",
  "uber",
  "airbnb",
  "instagram",
  "tiktok",
  "whatsapp",
  "telegram",
  "like uber",
  "like airbnb",
  "like instagram",
  "delivery app",
  "ride app",
  "ride sharing",
  "food delivery",
  "dating app",
  "fitness app",
  "workout app",
  "health app",
  "banking app",
  "wallet app",
  "shopping app",
  "e-commerce app",
  "marketplace app",
  "social app",
  "social network",
  "messaging app",
  "chat app",
];

/**
 * Keyword signals that strongly suggest a Go (Gin) backend is needed.
 * Checked after mobile but before generic backend signals.
 */
const GO_SIGNALS = [
  "golang",
  "go lang",
  "go rest api",
  "go rest",
  "go api",
  "go service",
  "go microservice",
  "go server",
  "go web",
  "gin framework",
  "gin-gonic",
  "go-gin",
  "go module",
  "go.mod",
  "go project",
  "goroutine",
  "go routine",
  "gopher",
  "go http",
  "go backend",
  "go application",
  "written in go",
  "built in go",
  "build in go",
  "using go",
  "with go",
];

/**
 * Keyword signals that strongly suggest a Python backend is needed.
 * Flask and FastAPI signals are separated to pick the right framework.
 */
const PYTHON_FLASK_SIGNALS = [
  "python flask",
  "flask app",
  "flask api",
  "flask server",
  "flask blueprint",
  "flask route",
  "flask web",
  "flask backend",
  "flask application",
  "python web server",
  "python rest api",
  "python api server",
  "python backend",
  "python server",
  "python script with endpoint",
  "python microservice",
  // Django prompts should still route to a Python pipeline (flask as closest match)
  // rather than falling through to node-api. Django-specific builds are out of scope
  // but we must not misclassify them as Node.js.
  "django",
  "python app",
  "python application",
  "python project",
];

const PYTHON_FASTAPI_SIGNALS = [
  "fastapi",
  "fast api",
  "python fastapi",
  "pydantic",
  "uvicorn",
  "async python",
  "python async api",
  "python async server",
  "python async backend",
];

/**
 * Keyword signals that strongly suggest a backend / database is required.
 * Matched case-insensitively against the user's prompt.
 */
const BACKEND_SIGNALS = [
  "database",
  "postgres",
  "mysql",
  "sqlite",
  "mongodb",
  "store data",
  "save data",
  "save to",
  "saved",
  "persist",
  "login",
  "log in",
  "logout",
  "log out",
  "signup",
  "sign up",
  "register",
  "authentication",
  "user account",
  "user profile",
  "user data",
  "session",
  "jwt",
  "token",
  "password",
  "rest api",
  "restful",
  "api endpoint",
  "api server",
  "backend",
  "server side",
  "serverside",
  "real-time",
  "realtime",
  "websocket",
  "file upload",
  "file storage",
  "payment",
  "stripe",
  "webhook",
  "email",
  "send email",
  "crud",
  "admin panel",
  "admin dashboard",
  "multi-user",
  "multiuser",
  "multiple users",
  "search",
  "full text search",
  "notification",
  "subscription",
];

/**
 * Keyword signals that suggest a React SPA (no dedicated backend).
 */
const REACT_SIGNALS = [
  "react",
  "vite",
  "component",
  "single page app",
  "spa",
  "dashboard",
  "chart",
  "recharts",
  "data visualization",
  "interactive",
];

/**
 * Automatically classify the required stack from the user's app description.
 *
 * Priority order (highest to lowest):
 *   1. mobile-cross — native mobile app signals (checked first, always wins)
 *   2. node-api     — full-stack backend + database signals
 *   3. react-vite   — rich SPA signals without a dedicated backend
 *   4. static-html  — default for simple pages with no detected complexity
 *
 * Falls back to a fast gpt-5-mini call when heuristics return no clear signal.
 */
/**
 * Classify a user prompt into the best-fit stack.
 *
 * @param prompt     The user's first message describing what they want to build.
 * @param devMode    When true (Developer Mode / agentic projects) "static-html" is
 *                   never returned — the minimum is "node-api" because every
 *                   Developer Mode project runs as a real server process inside a
 *                   Linux container.
 */
export async function detectRequiredStack(
  prompt: string,
  devMode = false,
): Promise<StackId> {
  const lower = prompt.toLowerCase();

  // Mobile intent always wins — a user asking for "an app like Uber" or
  // "a fitness tracking mobile app" should get a real native app, not a web page.
  if (MOBILE_SIGNALS.some((s) => lower.includes(s))) {
    return "mobile-cross";
  }

  // Specific output types — checked before generic web/backend signals so
  // "build me a pitch deck" doesn't accidentally become a React SPA.
  if (SLIDES_SIGNALS.some((s) => lower.includes(s))) {
    return "slides";
  }
  if (ANIMATION_SIGNALS.some((s) => lower.includes(s))) {
    return "animation";
  }
  if (AUTOMATION_SIGNALS.some((s) => lower.includes(s))) {
    return "automation";
  }

  // Go/Gin intent — checked before generic backend signals so Go prompts
  // don't fall through to node-api.
  if (GO_SIGNALS.some((s) => lower.includes(s))) {
    return "go-gin";
  }

  // FastAPI takes priority over generic Flask/Python detection.
  if (PYTHON_FASTAPI_SIGNALS.some((s) => lower.includes(s))) {
    return "python-fastapi";
  }

  // Flask / generic Python backend.
  if (PYTHON_FLASK_SIGNALS.some((s) => lower.includes(s))) {
    return "python-flask";
  }

  if (BACKEND_SIGNALS.some((s) => lower.includes(s))) {
    return "node-api";
  }
  if (REACT_SIGNALS.some((s) => lower.includes(s))) {
    return "react-vite";
  }

  // Unclear from keywords — ask the model. Keep it cheap: 20 output tokens max.
  //
  // In Developer Mode the "static" category is excluded: every project runs in a
  // real container so "react" (React SPA served by Vite dev-server) is the
  // lightest valid choice for content-only requests.
  const devModeNote = devMode
    ? 'NOTE: "static" is NOT a valid answer here — this project always runs in a container. Use "react" as the lightest server-backed option if nothing else fits.\n'
    : "";
  try {
    const { createChatCompletion } = await import("./ai-providers");
    const res = await createChatCompletion({
      provider: "openai",
      model: "gpt-5-mini",
      messages: [
        {
          role: "system",
          content:
            "Classify this request into exactly one category. Reply with a single word only.\n" +
            devModeNote +
            "Categories:\n" +
            "  mobile    — native phone/tablet app: something you'd install from the App Store or Play Store\n" +
            "  slides    — slide deck, presentation, or pitch deck (Reveal.js)\n" +
            "  animation — animated explainer, motion graphic, or branded animation\n" +
            "  automation — automation script, cron job, scheduled report, or data pipeline\n" +
            "  go        — Go (Golang) backend: REST API or microservice using Go / Gin framework\n" +
            "  fastapi   — Python FastAPI backend: async Python API with Pydantic models\n" +
            "  flask     — Python Flask backend: web app or REST API using Flask\n" +
            "  fullstack — Node.js/TypeScript web app that needs a real backend: user auth, database, file uploads, payments, APIs\n" +
            "  react     — rich web single-page app, dashboard, or data viz with no server-side database\n" +
            (devMode
              ? ""
              : "  static    — simple web page: landing page, portfolio, brochure, no persistent data\n") +
            (devMode
              ? "Reply with ONLY one of: mobile | slides | animation | automation | go | fastapi | flask | fullstack | react"
              : "Reply with ONLY one of: mobile | slides | animation | automation | go | fastapi | flask | fullstack | react | static"),
        },
        { role: "user", content: prompt.slice(0, 800) },
      ],
      max_completion_tokens: 10,
    });
    const word = res.choices[0]?.message?.content?.trim().toLowerCase() ?? "";
    if (word.includes("mobile")) return "mobile-cross";
    if (word.includes("slides") || word.includes("slide")) return "slides";
    if (word.includes("animation") || word.includes("animate")) return "animation";
    if (word.includes("automation") || word.includes("automate")) return "automation";
    if (word.includes("go")) return "go-gin";
    if (word.includes("fastapi")) return "python-fastapi";
    if (word.includes("flask")) return "python-flask";
    if (word.includes("fullstack") || word.includes("full")) return "node-api";
    if (word.includes("react")) return "react-vite";
    // "static" response in devMode → upgrade to node-api (minimum container stack).
    if (!devMode && word.includes("static")) return "static-html";
    return devMode ? "node-api" : "static-html";
  } catch (err) {
    logger.warn(
      { err },
      devMode
        ? "Stack auto-detection AI call failed — defaulting to node-api (Developer Mode)"
        : "Stack auto-detection AI call failed — defaulting to static-html",
    );
    return devMode ? "node-api" : "static-html";
  }
}
