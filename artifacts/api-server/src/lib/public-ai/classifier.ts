import { logger } from "../logger";

export type OraIntent = "simple_faq" | "premium" | "builder_request";
export type OraConfidence = "high" | "low";
export type OraTopic =
  | "product-features"
  | "pricing"
  | "app-planning"
  | "saas"
  | "ecommerce"
  | "mobile"
  | "technical"
  | "onboarding"
  | "general";

export interface ClassifierResult {
  intent: OraIntent;
  confidence: OraConfidence;
  topic: OraTopic;
}

const CLASSIFIER_SYSTEM_PROMPT = `You are an intent classifier for Ora, a public AI assistant. Your only job is to classify the user's message and return valid JSON.

Return ONLY this JSON format, no prose, no markdown:
{"intent":"<intent>","confidence":"<confidence>","topic":"<topic>"}

Intent values:
"simple_faq" / high — short factual question about MustaFlow (pricing, features, what it does, how to sign up) where the answer is straightforward
"simple_faq" / low — possible FAQ but you are not fully sure it is simple
"premium" / high — clearly requires analysis, strategy, explanation, problem-solving, brainstorming, planning, or substantive reasoning
"premium" / low — possibly needs deeper reasoning but unsure
"builder_request" / high — clear request to build, code, deploy, or access platform tools
"builder_request" / low — possibly a build/deploy request but ambiguous

Topic values (pick the single most relevant):
"product-features" — questions about MustaFlow capabilities, integrations, or how it works
"pricing" — pricing, plans, credits, billing, or cost questions
"onboarding" — getting started, signing up, first steps, tutorials
"app-planning" — planning or designing an app idea (requirements, scope, architecture)
"saas" — SaaS product domain (subscriptions, auth, dashboards, multi-tenancy)
"ecommerce" — e-commerce domain (stores, products, payments, checkout)
"mobile" — mobile app domain (iOS, Android, Expo, React Native)
"technical" — technical depth (databases, APIs, deployment, performance, security)
"general" — none of the above / mixed

Rules:
- When in doubt between simple_faq and premium, choose premium with high confidence.
- Only use simple_faq with high confidence for genuinely short factual questions (e.g. "What is MustaFlow?", "How much does it cost?").
- Never return anything other than the JSON format above.`;

const DEFAULT_RESULT: ClassifierResult = {
  intent: "premium",
  confidence: "high",
  topic: "general",
};

export async function classifyIntent(userMessage: string): Promise<ClassifierResult> {
  const start = Date.now();
  const model = process.env.ORA_CLASSIFIER_MODEL ?? "gpt-5-nano";
  let usedDefault = false;

  try {
    const { createChatCompletion } = await import("../ai-providers");
    const result = await createChatCompletion({
      provider: "openai",
      model,
      messages: [
        { role: "system", content: CLASSIFIER_SYSTEM_PROMPT },
        { role: "user", content: userMessage.slice(0, 500) },
      ],
      response_format: { type: "json_object" },
      max_completion_tokens: 150,
    });

    const raw = result.choices[0]?.message?.content?.trim() ?? "";
    if (!raw) {
      usedDefault = true;
      logger.info(
        {
          component: "ora-classifier",
          model,
          latencyMs: Date.now() - start,
          ...DEFAULT_RESULT,
          usedDefault,
        },
        "Classifier returned empty — defaulting to premium/high",
      );
      return DEFAULT_RESULT;
    }

    let parsed: { intent?: string; confidence?: string; topic?: string } = {};
    try {
      parsed = JSON.parse(raw) as { intent?: string; confidence?: string; topic?: string };
    } catch {
      usedDefault = true;
      logger.info(
        {
          component: "ora-classifier",
          model,
          latencyMs: Date.now() - start,
          ...DEFAULT_RESULT,
          usedDefault,
        },
        "Classifier returned invalid JSON — defaulting to premium/high",
      );
      return DEFAULT_RESULT;
    }

    const intent = parsed.intent;
    const rawConf = parsed.confidence;
    const rawTopic = parsed.topic;
    const confidence: OraConfidence = rawConf === "low" ? "low" : "high";

    const VALID_TOPICS: OraTopic[] = [
      "product-features",
      "pricing",
      "app-planning",
      "saas",
      "ecommerce",
      "mobile",
      "technical",
      "onboarding",
      "general",
    ];
    const topic: OraTopic =
      typeof rawTopic === "string" && VALID_TOPICS.includes(rawTopic as OraTopic)
        ? (rawTopic as OraTopic)
        : "general";

    if (intent === "simple_faq" || intent === "premium" || intent === "builder_request") {
      logger.info(
        {
          component: "ora-classifier",
          model,
          latencyMs: Date.now() - start,
          intent,
          confidence,
          topic,
          usedDefault,
        },
        "Classifier result",
      );
      return { intent, confidence, topic };
    }

    usedDefault = true;
    logger.info(
      {
        component: "ora-classifier",
        model,
        latencyMs: Date.now() - start,
        ...DEFAULT_RESULT,
        usedDefault,
        raw,
      },
      "Classifier returned unknown intent — defaulting to premium/high",
    );
    return DEFAULT_RESULT;
  } catch (err) {
    usedDefault = true;
    logger.info(
      {
        component: "ora-classifier",
        model,
        latencyMs: Date.now() - start,
        ...DEFAULT_RESULT,
        usedDefault,
        err,
      },
      "Classifier threw — defaulting to premium/high",
    );
    return DEFAULT_RESULT;
  }
}
