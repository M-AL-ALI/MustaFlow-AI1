/**
 * Ora routing audit helper.
 *
 * Usage:
 *   pnpm --filter @workspace/scripts run ora-routing-audit
 *   pnpm --filter @workspace/scripts run ora-routing-audit -- --prompt="debug this API" --plan=core
 *   pnpm --filter @workspace/scripts run ora-routing-audit -- --surface=vision_analysis --plan=wave
 */

import {
  buildOraRoutingDiagnostic,
  type OraDiagnosticSurface,
} from "../../artifacts/api-server/src/lib/public-ai/routing-diagnostics.js";
import type {
  OraConfidence,
  OraIntent,
  OraTopic,
} from "../../artifacts/api-server/src/lib/public-ai/classifier.js";
import type { OraPlanTier } from "../../artifacts/api-server/src/lib/public-ai/model-router.js";

type AuditCase = {
  label: string;
  message: string;
  surface?: OraDiagnosticSurface;
  mode?: "instant" | "deep";
  classifier?: { intent: OraIntent; confidence: OraConfidence; topic: OraTopic };
  useLiveClassifier?: boolean;
  fileFormat?: "csv" | "xlsx" | "docx" | "pdf" | "pptx";
};

const DEFAULT_CLASSIFIER = {
  intent: "premium",
  confidence: "high",
  topic: "general",
} as const;

const DEFAULT_CASES: AuditCase[] = [
  {
    label: "FAQ",
    message: "what can Ora do?",
    classifier: { intent: "simple_faq", confidence: "high", topic: "product-features" },
  },
  {
    label: "Technical",
    message: "debug a Node API performance issue",
    classifier: { intent: "premium", confidence: "high", topic: "technical" },
  },
  {
    label: "Deep",
    message: "analyze this launch strategy deeply",
    mode: "deep",
    classifier: DEFAULT_CLASSIFIER,
  },
  {
    label: "Search Images",
    message: "find official logo images for Perdue",
  },
  {
    label: "File XLSX",
    message: "create an xlsx budget tracker",
    surface: "file_generation",
    fileFormat: "xlsx",
  },
  {
    label: "Vision",
    message: "what is in this image?",
    surface: "vision_analysis",
  },
  {
    label: "Memory",
    message: "remember that I prefer concise answers",
    surface: "memory_extract",
  },
  {
    label: "Pasted Report",
    message:
      "Task #1412 landed, pull-from-github completed, quality-gate passed, typecheck clean. What should I tell Replit?",
    classifier: { intent: "premium", confidence: "high", topic: "technical" },
  },
];

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (const arg of argv) {
    if (!arg.startsWith("--")) continue;
    const eq = arg.indexOf("=");
    if (eq === -1) {
      out[arg.slice(2)] = true;
    } else {
      out[arg.slice(2, eq)] = arg.slice(eq + 1);
    }
  }
  return out;
}

function asPlan(value: unknown): OraPlanTier | undefined {
  return value === "anonymous" || value === "free" || value === "core" || value === "wave"
    ? value
    : undefined;
}

function asSurface(value: unknown): OraDiagnosticSurface | undefined {
  const surfaces: OraDiagnosticSurface[] = [
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
  ];
  return typeof value === "string" && surfaces.includes(value as OraDiagnosticSurface)
    ? (value as OraDiagnosticSurface)
    : undefined;
}

function providerChain(order: string[]): string {
  return order.length > 0 ? order.join(" -> ") : "(none)";
}

function printUsage(): void {
  console.log(`Ora routing audit

Options:
  --prompt="text"          Audit one custom prompt
  --plan=anonymous|free|core|wave
  --surface=<surface>      Optional explicit surface
  --mode=instant|deep
  --json                   Print JSON instead of a table
`);
}

const args = parseArgs(process.argv.slice(2));
if (args.help || args.h) {
  printUsage();
  process.exit(0);
}

const selectedPlan = asPlan(args.plan);
const plans: OraPlanTier[] = selectedPlan ? [selectedPlan] : ["anonymous", "free", "core", "wave"];
const customPrompt = typeof args.prompt === "string" ? args.prompt.trim() : "";
const customSurface = asSurface(args.surface);
const customMode = args.mode === "deep" ? "deep" : "instant";
const cases: AuditCase[] = customPrompt
  ? [
      {
        label: "Custom",
        message: customPrompt,
        surface: customSurface,
        mode: customMode,
        classifier: DEFAULT_CLASSIFIER,
        useLiveClassifier: args["live-classifier"] === true,
      },
    ]
  : DEFAULT_CASES;

const rows = [];
for (const plan of plans) {
  for (const item of cases) {
    const diagnostic = await buildOraRoutingDiagnostic({
      message: item.message,
      surface: item.surface,
      mode: item.mode ?? "instant",
      subscriptionTier: plan === "anonymous" ? null : plan,
      classifier: item.useLiveClassifier ? undefined : (item.classifier ?? DEFAULT_CLASSIFIER),
      fileFormat: item.fileFormat,
    });
    rows.push({
      plan,
      case: item.label,
      surface: diagnostic.surface,
      tool: diagnostic.tool ?? "(none)",
      access:
        diagnostic.access?.allowed === false ? `denied:${diagnostic.access.denyCode}` : "allowed",
      quota: diagnostic.quotaKind ?? "(none)",
      route: diagnostic.routeTier ?? "(none)",
      openai: diagnostic.openaiModel ?? "(none)",
      providers: providerChain(diagnostic.providerOrder),
    });
  }
}

if (args.json) {
  console.log(JSON.stringify(rows, null, 2));
} else {
  console.table(rows);
}
