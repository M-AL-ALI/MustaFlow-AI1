import { Router } from "express";
import { z } from "zod";
import { logger } from "../lib/logger";

const router = Router();

const messagesSchema = z
  .array(
    z.object({
      role: z.enum(["user", "assistant"]),
      content: z.string().max(2000),
    }),
  )
  .max(30);

const bodySchema = z.object({ messages: messagesSchema });

const CHAT_SYSTEM_PROMPT = `You are a concise product ideation partner. Help the user clarify what they want to build by asking one short, focused clarifying question at a time. When the user clearly signals readiness to build (e.g. "build it", "let's go", "looks good", "make it"), set buildIntent to true. Never write code. Respond with valid JSON: {"reply": "...", "buildIntent": false}`;

const RESOLVE_SYSTEM_PROMPT = `Given this product ideation conversation, respond with valid JSON containing exactly: name (3-5 word title-case project name, no special characters), prompt (one clear paragraph summarising what to build), kind (either "web" or "mobile-cross" — use "mobile-cross" only if a native iOS/Android app was explicitly discussed).`;

const chatOutputSchema = z.object({
  reply: z.string(),
  buildIntent: z.boolean(),
});

const resolveOutputSchema = z.object({
  name: z.string().max(80),
  prompt: z.string().max(500),
  kind: z.enum(["web", "mobile-cross"]),
});

router.post("/brainstorm/chat", async (req, res) => {
  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request body" });
    return;
  }

  try {
    const { createChatCompletion } = await import("../lib/ai-providers");
    const result = await createChatCompletion({
      provider: "openai",
      model: "gpt-5-mini",
      messages: [{ role: "system", content: CHAT_SYSTEM_PROMPT }, ...parsed.data.messages],
      response_format: { type: "json_object" },
      max_completion_tokens: 400,
    });

    const raw = result.choices[0]?.message?.content?.trim() ?? "{}";
    let parsed2: { reply: string; buildIntent: boolean } | null = null;
    try {
      parsed2 = chatOutputSchema.parse(JSON.parse(raw));
    } catch {
      parsed2 = null;
    }

    if (!parsed2) {
      res.json({ reply: "Tell me more about what you'd like to build.", buildIntent: false });
      return;
    }

    res.json({ reply: parsed2.reply, buildIntent: parsed2.buildIntent });
  } catch (err) {
    logger.error({ err }, "brainstorm/chat AI call failed");
    res.status(502).json({ error: "AI service unavailable" });
  }
});

router.post("/brainstorm/resolve", async (req, res) => {
  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request body" });
    return;
  }

  const callResolve = async (extraInstruction?: string) => {
    const { createChatCompletion } = await import("../lib/ai-providers");
    const systemContent = extraInstruction
      ? `${RESOLVE_SYSTEM_PROMPT}\n\n${extraInstruction}`
      : RESOLVE_SYSTEM_PROMPT;
    const result = await createChatCompletion({
      provider: "openai",
      model: "gpt-5-mini",
      messages: [{ role: "system", content: systemContent }, ...parsed.data.messages],
      response_format: { type: "json_object" },
      max_completion_tokens: 300,
    });
    return result.choices[0]?.message?.content?.trim() ?? "{}";
  };

  const fallback = () => {
    const lastUserContent =
      parsed.data.messages.filter((m) => m.role === "user").at(-1)?.content ?? "";
    return { name: "My New Project", prompt: lastUserContent, kind: "web" as const };
  };

  try {
    const raw = await callResolve();
    let output = resolveOutputSchema.safeParse(JSON.parse(raw));

    if (!output.success) {
      const raw2 = await callResolve(
        "You MUST respond with ONLY valid JSON matching the schema. No prose, no markdown.",
      );
      output = resolveOutputSchema.safeParse(JSON.parse(raw2));
    }

    if (!output.success) {
      res.json(fallback());
      return;
    }

    res.json({ name: output.data.name, prompt: output.data.prompt, kind: output.data.kind });
  } catch (err) {
    logger.error({ err }, "brainstorm/resolve AI call failed");
    res.json(fallback());
  }
});

export default router;
