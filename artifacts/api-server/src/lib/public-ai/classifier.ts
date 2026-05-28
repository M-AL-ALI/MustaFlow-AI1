import { logger } from "../logger";

export type OraIntent = "simple_faq" | "premium" | "builder_request";
export type OraConfidence = "high" | "low";

export interface ClassifierResult {
  intent: OraIntent;
  confidence: OraConfidence;
}

const CLASSIFIER_SYSTEM_PROMPT = `You are an intent classifier for Ora, a public AI assistant. Your only job is to classify the user's message and return valid JSON.

Return ONLY this JSON format, no prose, no markdown:
{"intent":"simple_faq","confidence":"high"} — short factual question about MustaFlow (pricing, features, what it does, how to sign up) where the answer is straightforward
{"intent":"simple_faq","confidence":"low"} — possible FAQ but you are not fully sure it is simple
{"intent":"premium","confidence":"high"} — clearly requires analysis, strategy, explanation, problem-solving, brainstorming, planning, or substantive reasoning
{"intent":"premium","confidence":"low"} — possibly needs deeper reasoning but unsure
{"intent":"builder_request","confidence":"high"} — clear request to build, code, deploy, or access platform tools
{"intent":"builder_request","confidence":"low"} — possibly a build/deploy request but ambiguous

Rules:
- When in doubt between simple_faq and premium, choose premium with high confidence.
- Only use simple_faq with high confidence for genuinely short factual questions (e.g. "What is MustaFlow?", "How much does it cost?").
- Never return anything other than the JSON format above.`;

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
          intent: "premium",
          confidence: "high",
          usedDefault,
        },
        "Classifier returned empty — defaulting to premium/high",
      );
      return { intent: "premium", confidence: "high" };
    }

    let parsed: { intent?: string; confidence?: string } = {};
    try {
      parsed = JSON.parse(raw) as { intent?: string; confidence?: string };
    } catch {
      usedDefault = true;
      logger.info(
        {
          component: "ora-classifier",
          model,
          latencyMs: Date.now() - start,
          intent: "premium",
          confidence: "high",
          usedDefault,
        },
        "Classifier returned invalid JSON — defaulting to premium/high",
      );
      return { intent: "premium", confidence: "high" };
    }

    const intent = parsed.intent;
    const rawConf = parsed.confidence;
    const confidence: OraConfidence = rawConf === "low" ? "low" : "high";

    if (intent === "simple_faq" || intent === "premium" || intent === "builder_request") {
      logger.info(
        {
          component: "ora-classifier",
          model,
          latencyMs: Date.now() - start,
          intent,
          confidence,
          usedDefault,
        },
        "Classifier result",
      );
      return { intent, confidence };
    }

    usedDefault = true;
    logger.info(
      {
        component: "ora-classifier",
        model,
        latencyMs: Date.now() - start,
        intent: "premium",
        confidence: "high",
        usedDefault,
        raw,
      },
      "Classifier returned unknown intent — defaulting to premium/high",
    );
    return { intent: "premium", confidence: "high" };
  } catch (err) {
    usedDefault = true;
    logger.info(
      {
        component: "ora-classifier",
        model,
        latencyMs: Date.now() - start,
        intent: "premium",
        confidence: "high",
        usedDefault,
        err,
      },
      "Classifier threw — defaulting to premium/high",
    );
    return { intent: "premium", confidence: "high" };
  }
}
