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

const SYSTEM_PROMPT = `You are MustaFlow AI, a friendly, focused AI app-building assistant. You help non-technical users plan, design, and build web, iOS, and Android apps. You are concise, encouraging, and never use emojis. You speak in plain English, never jargon.

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

export type StackId = "static-html" | "react-vite" | "node-api" | "mobile-cross";

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
export async function detectRequiredStack(prompt: string): Promise<StackId> {
  const lower = prompt.toLowerCase();

  // Mobile intent always wins — a user asking for "an app like Uber" or
  // "a fitness tracking mobile app" should get a real native app, not a web page.
  if (MOBILE_SIGNALS.some((s) => lower.includes(s))) {
    return "mobile-cross";
  }
  if (BACKEND_SIGNALS.some((s) => lower.includes(s))) {
    return "node-api";
  }
  if (REACT_SIGNALS.some((s) => lower.includes(s))) {
    return "react-vite";
  }

  // Unclear from keywords — ask the model. Keep it cheap: 20 output tokens max.
  try {
    const { createChatCompletion } = await import("./ai-providers");
    const res = await createChatCompletion({
      provider: "openai",
      model: "gpt-5-mini",
      messages: [
        {
          role: "system",
          content:
            "Classify this app idea into exactly one category. Reply with a single word only.\n" +
            "Categories:\n" +
            "  mobile    — native phone/tablet app: something you'd install from the App Store or Play Store\n" +
            "  fullstack — web app that needs a real backend: user auth, database, file uploads, payments, APIs\n" +
            "  react     — rich web single-page app, dashboard, or data viz with no server-side database\n" +
            "  static    — simple web page: landing page, portfolio, brochure, no persistent data\n" +
            "Reply with ONLY one of: mobile | fullstack | react | static",
        },
        { role: "user", content: prompt.slice(0, 800) },
      ],
      max_completion_tokens: 10,
    });
    const word = res.choices[0]?.message?.content?.trim().toLowerCase() ?? "";
    if (word.includes("mobile")) return "mobile-cross";
    if (word.includes("fullstack") || word.includes("full")) return "node-api";
    if (word.includes("react")) return "react-vite";
    return "static-html";
  } catch (err) {
    logger.warn({ err }, "Stack auto-detection AI call failed — defaulting to static-html");
    return "static-html";
  }
}
