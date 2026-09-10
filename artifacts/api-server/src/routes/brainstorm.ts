import { Router, type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import { attachUser } from "../lib/auth";
import {
  buildBrainstormChatSystemPrompt,
  buildBrainstormResolveSystemPrompt,
  loadBrainstormProjectContext,
  requestBrainstormJson,
  type BrainstormProjectContext,
} from "../lib/brainstorm";
import { logger } from "../lib/logger";

const router = Router();
const MAX_REPLY_CHARACTERS = 6000;
const messagesSchema = z
  .array(
    z.discriminatedUnion("role", [
      z.object({ role: z.literal("user"), content: z.string().trim().min(1).max(2000) }),
      z.object({
        role: z.literal("assistant"),
        content: z.string().trim().min(1).max(MAX_REPLY_CHARACTERS),
      }),
    ]),
  )
  .min(1)
  .max(30)
  .refine((messages) => messages.some((message) => message.role === "user"));
const baseBodySchema = z.object({
  messages: messagesSchema,
  projectId: z.number().int().positive().max(2_147_483_647).optional(),
  beginnerMode: z.boolean().optional().default(false),
});
const chatBodySchema = baseBodySchema.extend({
  messages: messagesSchema.refine((messages) => messages.length <= 29),
});
const resolveBodySchema = baseBodySchema.extend({ action: z.enum(["plan", "build"]) });
const chatOutputSchema = z.object({
  reply: z.string().trim().min(1).max(MAX_REPLY_CHARACTERS),
  buildIntent: z.boolean(),
});
const resolveOutputSchema = z.object({
  name: z.string().trim().min(1).max(80),
  prompt: z.string().trim().min(1).max(2000),
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
  const parsed = chatBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request body" });
    return;
  }
  try {
    const context = await resolveProjectContext(parsed.data.projectId, req.userId);
    if (context === "missing") {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    res.json(
      await requestBrainstormJson({
        systemPrompt: buildBrainstormChatSystemPrompt(context, parsed.data.beginnerMode),
        messages: parsed.data.messages,
        schema: chatOutputSchema,
      }),
    );
  } catch (err) {
    logger.error({ err }, "brainstorm/chat AI call failed");
    res.status(502).json({
      error: "Brainstorming could not finish. Please try again.",
      code: "brainstorm_response_unavailable",
    });
  }
});

router.post("/brainstorm/resolve", attachProjectUserWhenNeeded, async (req, res) => {
  const parsed = resolveBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request body" });
    return;
  }
  try {
    const context = await resolveProjectContext(parsed.data.projectId, req.userId);
    if (context === "missing") {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    const output = await requestBrainstormJson({
      systemPrompt: buildBrainstormResolveSystemPrompt(context, parsed.data.action),
      messages: parsed.data.messages,
      schema: resolveOutputSchema,
    });
    res.json({ ...output, action: parsed.data.action, brainstormContext: parsed.data.messages });
  } catch (err) {
    logger.error({ err }, "brainstorm/resolve AI call failed");
    res.status(502).json({
      error: "Your project brief could not be prepared. Please try again.",
      code: "brainstorm_response_unavailable",
    });
  }
});
export default router;
