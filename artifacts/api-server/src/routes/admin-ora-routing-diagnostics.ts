import { Router, type IRouter } from "express";
import { z } from "zod";
import { requireAdmin } from "../lib/adminAuth";
import { logger } from "../lib/logger";
import {
  buildOraRoutingDiagnostic,
  type OraRoutingDiagnosticInput,
} from "../lib/public-ai/routing-diagnostics";
import type { Provider } from "../lib/ai-providers";

const surfaceSchema = z.enum([
  "auto",
  "answer",
  "deep_thinking",
  "search",
  "file_generation",
  "file_analysis",
  "dataset_analysis",
  "vision_analysis",
  "memory_extract",
  "conversation_summary",
  "document_memory",
  "image_generation",
  "image_edit",
]);

const providerSchema = z.enum(["openai", "anthropic", "gemini", "deepseek"]);

const classifierSchema = z.object({
  intent: z.enum(["simple_faq", "premium", "builder_request"]),
  confidence: z.enum(["high", "low"]),
  topic: z.enum([
    "product-features",
    "pricing",
    "app-planning",
    "saas",
    "ecommerce",
    "mobile",
    "technical",
    "onboarding",
    "general",
  ]),
});

const recentMessageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string().trim().min(1).max(4000),
});

const availabilitySchema = z
  .object({
    openai: z.boolean().optional(),
    anthropic: z.boolean().optional(),
    gemini: z.boolean().optional(),
    deepseek: z.boolean().optional(),
  })
  .strict();

const diagnosticBodySchema = z
  .object({
    message: z.string().trim().min(1).max(8000),
    surface: surfaceSchema.optional(),
    mode: z.enum(["instant", "deep"]).optional(),
    subscriptionTier: z.string().trim().max(50).nullable().optional(),
    classifier: classifierSchema.optional(),
    language: z.string().trim().max(80).optional(),
    languageHint: z.string().trim().max(80).optional(),
    hasDocumentContext: z.boolean().optional(),
    recentMessages: z.array(recentMessageSchema).max(20).optional(),
    fileFormat: z.enum(["csv", "xlsx", "docx", "pdf", "pptx"]).optional(),
    fileTask: z.enum(["generation", "analysis", "dataset_analysis"]).optional(),
    memoryTask: z.enum(["extract", "conversation_summary", "document_summary"]).optional(),
    imageTask: z.enum(["generation", "edit"]).optional(),
    available: availabilitySchema.optional(),
    openCircuits: z.array(providerSchema).max(4).optional(),
    useLiveClassifier: z.boolean().optional(),
  })
  .strict();

const router: IRouter = Router();

const DEFAULT_DIAGNOSTIC_CLASSIFIER = {
  intent: "premium",
  confidence: "high",
  topic: "general",
} as const;

router.post("/admin/ora-routing/diagnostics", requireAdmin, async (req, res): Promise<void> => {
  const parsed = diagnosticBodySchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({
      error: "invalid_request",
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      })),
    });
    return;
  }

  const { openCircuits, useLiveClassifier, ...body } = parsed.data;
  const input: OraRoutingDiagnosticInput = {
    ...body,
    classifier: body.classifier ?? (useLiveClassifier ? undefined : DEFAULT_DIAGNOSTIC_CLASSIFIER),
    openCircuits: openCircuits ? new Set(openCircuits as Provider[]) : undefined,
  };

  try {
    const diagnostic = await buildOraRoutingDiagnostic(input);
    res.json({ ok: true, diagnostic });
  } catch (err) {
    logger.error({ err }, "Ora routing diagnostic failed");
    res.status(500).json({ error: "ora_routing_diagnostic_failed" });
  }
});

export default router;
