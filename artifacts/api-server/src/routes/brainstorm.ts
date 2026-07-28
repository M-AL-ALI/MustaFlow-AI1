import { Router, type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import { attachUser } from "../lib/auth";
import {
  buildBrainstormChatSystemPrompt,
  buildBrainstormResolveSystemPrompt,
  loadBrainstormProjectContext,
  type BrainstormProjectContext,
} from "../lib/brainstorm";
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

const baseBodySchema = z.object({
  messages: messagesSchema,
  projectId: z.number().int().positive().optional(),
  beginnerMode: z.boolean().optional().default(false),
});

const resolveBodySchema = baseBodySchema.extend({
  action: z.enum(["plan", "build"]),
});

const chatOutputSchema = z.object({
  reply: z.string(),
  buildIntent: z.boolean(),
});

const resolveOutputSchema = z.object({
  name: z.string().max(80),
  prompt: z.string().max(500),
  kind: z.enum(["web", "mobile-cross"]),
});

function attachProjectUserWhenNeeded(req: Request, res: Response, next: NextFunction): void {
  if (req.body?.projectId == null) {
    next();
    return;
  }
  attachUser(req, res, next);
}

async function resolveProjectContext(
  projectId: number | undefined,
  userId: string | undefined,
): Promise<BrainstormProjectContext | null | "missing"> {
  if (projectId == null) return null;
  if (!userId) return "missing";
  return (await loadBrainstormProjectContext(projectId, userId)) ?? "missing";
}

router.post("/brainstorm/chat", attachProjectUserWhenNeeded, async (req, res) => {
  const parsed = baseBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request body" });
    return;
  }

  try {
    const projectContext = await resolveProjectContext(parsed.data.projectId, req.userId);
    if (projectContext === "missing") {
      res.status(404).json({ error: "Project not found" });
      return;
    }

    const { createChatCompletion } = await import("../lib/ai-providers");
    const result = await createChatCompletion({
      provider: "openai",
      model: "gpt-5-mini",
      messages: [
        {
          role: "system",
          content: buildBrainstormChatSystemPrompt(projectContext, parsed.data.beginnerMode),
        },
        ...parsed.data.messages,
      ],
      response_format: { type: "json_object" },
      max_completion_tokens: 400,
    });

    const raw = result.choices[0]?.message?.content?.trim() ?? "{}";
    let decoded: unknown;
    try {
      decoded = JSON.parse(raw);
    } catch {
      decoded = null;
    }
    const output = chatOutputSchema.safeParse(decoded);
    if (!output.success) {
      res.json({ reply: "Tell me more about what you'd like to build.", buildIntent: false });
      return;
    }

    res.json(output.data);
  } catch (err) {
    logger.error({ err }, "brainstorm/chat AI call failed");
    res.status(502).json({ error: "AI service unavailable" });
  }
});

router.post("/brainstorm/resolve", attachProjectUserWhenNeeded, async (req, res) => {
  const parsed = resolveBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request body" });
    return;
  }

  const projectContext = await resolveProjectContext(parsed.data.projectId, req.userId);
  if (projectContext === "missing") {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  const callResolve = async (extraInstruction?: string) => {
    const { createChatCompletion } = await import("../lib/ai-providers");
    const basePrompt = buildBrainstormResolveSystemPrompt(projectContext, parsed.data.action);
    const systemContent = extraInstruction ? `${basePrompt}\n\n${extraInstruction}` : basePrompt;
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
      parsed.data.messages.filter((message) => message.role === "user").at(-1)?.content ?? "";
    return {
      name: projectContext?.projectName ?? "My New Project",
      prompt: lastUserContent,
      kind: (projectContext?.projectKind === "mobile-cross" ? "mobile-cross" : "web") as
        | "web"
        | "mobile-cross",
    };
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

    const resolved = output.success ? output.data : fallback();
    res.json({
      ...resolved,
      action: parsed.data.action,
      brainstormContext: parsed.data.messages,
    });
  } catch (err) {
    logger.error({ err }, "brainstorm/resolve AI call failed");
    res.json({
      ...fallback(),
      action: parsed.data.action,
      brainstormContext: parsed.data.messages,
    });
  }
});

export default router;
