import type { OraConfidence, OraIntent, OraTopic } from "./classifier";
import type { OraPlanTier, OraRouteTier } from "./model-router";

export type OraExpertiseDomain =
  | "software_engineering"
  | "product_strategy"
  | "business_strategy"
  | "data_analysis"
  | "finance"
  | "legal"
  | "health"
  | "writing"
  | "operations"
  | "troubleshooting"
  | "general";

export type OraAnswerDepth = "concise" | "standard" | "expert" | "deep";

export interface OraExpertiseProfile {
  domain: OraExpertiseDomain;
  depth: OraAnswerDepth;
  maxTokens: number;
  systemAddendum: string;
}

export interface OraExpertiseInput {
  message: string;
  topic: OraTopic;
  planTier: OraPlanTier;
  routeTier: OraRouteTier;
  intent: OraIntent;
  confidence: OraConfidence;
  hasDocumentContext?: boolean;
}

const DOMAIN_PATTERNS: Array<{ domain: OraExpertiseDomain; patterns: RegExp[] }> = [
  {
    domain: "health",
    patterns: [
      /\b(doctor|medical|medicine|symptoms?|diagnos(?:e|is)|treatment|prescription|therapy|mental health|anxiety|depression)\b/i,
    ],
  },
  {
    domain: "legal",
    patterns: [
      /\b(legal|lawyer|attorney|contract|terms of service|privacy policy|lawsuit|liability|compliance|gdpr|hipaa|copyright|trademark)\b/i,
    ],
  },
  {
    domain: "finance",
    patterns: [
      /\b(invest(?:ment|ing|or|ors)?|stock(?:s| market| price)?|crypto(?:currency)?|personal tax|income tax|tax return|capital gains|loan|mortgage|401k|ira|pension|brokerage|portfolio|dividend|equity stake|personal finance)\b/i,
    ],
  },
  {
    domain: "software_engineering",
    patterns: [
      /\b(code|debug|api|database|sql|typescript|javascript|python|react|node|server|deployment|auth|security|performance|architecture)\b/i,
    ],
  },
  {
    domain: "data_analysis",
    patterns: [
      /\b(data|dataset|spreadsheet|csv|excel|analysis|analytics|metric|kpi|dashboard|forecast|trend|correlation|regression)\b/i,
    ],
  },
  {
    domain: "product_strategy",
    patterns: [
      /\b(product|mvp|roadmap|feature|user flow|requirements?|scope|prototype|ux|onboarding|retention|churn)\b/i,
    ],
  },
  {
    domain: "business_strategy",
    patterns: [
      /\b(business|startup|market|competitor|go-to-market|pricing|sales|marketing|positioning|customer segment|revenue model)\b/i,
    ],
  },
  {
    domain: "operations",
    patterns: [
      /\b(workflow|process|sop|operations?|automation|handoff|team|staff|schedule|inventory|fulfillment|support queue)\b/i,
    ],
  },
  {
    domain: "troubleshooting",
    patterns: [
      /\b(error|issue|problem|broken|not working|fails?|failure|bug|crash|slow|stuck|root cause|fix)\b/i,
    ],
  },
  {
    domain: "writing",
    patterns: [
      /\b(write|rewrite|draft|email|copy|article|blog|story|tone|grammar|summarize|summary)\b/i,
    ],
  },
];

export function detectOraExpertiseDomain(message: string, topic: OraTopic): OraExpertiseDomain {
  const regulated = DOMAIN_PATTERNS.slice(0, 3);
  for (const candidate of regulated) {
    if (candidate.patterns.some((pattern) => pattern.test(message))) return candidate.domain;
  }

  if (topic === "technical" || topic === "mobile") return "software_engineering";
  if (topic === "app-planning") return "product_strategy";
  if (topic === "saas" || topic === "ecommerce" || topic === "pricing") return "business_strategy";
  if (topic === "onboarding" || topic === "product-features") return "product_strategy";

  for (const candidate of DOMAIN_PATTERNS.slice(3)) {
    if (candidate.patterns.some((pattern) => pattern.test(message))) return candidate.domain;
  }
  return "general";
}

export function resolveOraAnswerDepth(input: {
  planTier: OraPlanTier;
  routeTier: OraRouteTier;
  intent: OraIntent;
  confidence: OraConfidence;
}): OraAnswerDepth {
  if (input.routeTier === "deep") return "deep";
  if (
    input.routeTier === "fast" ||
    (input.intent === "simple_faq" && input.confidence === "high")
  ) {
    return "concise";
  }
  if (input.planTier === "wave") return "expert";
  return "standard";
}

function tokenBudgetFor(input: {
  planTier: OraPlanTier;
  routeTier: OraRouteTier;
  depth: OraAnswerDepth;
  domain: OraExpertiseDomain;
  hasDocumentContext?: boolean;
}): number {
  if (input.routeTier === "fast" || input.depth === "concise") return 450;

  const substantiveDomain = new Set<OraExpertiseDomain>([
    "software_engineering",
    "data_analysis",
    "finance",
    "legal",
    "health",
    "troubleshooting",
  ]);
  const domainBoost = substantiveDomain.has(input.domain) || input.hasDocumentContext ? 250 : 0;

  if (input.routeTier === "deep") {
    const base = input.planTier === "wave" ? 3200 : 2600;
    return base + domainBoost;
  }

  if (input.planTier === "wave") return 2000 + domainBoost;
  if (input.planTier === "core") return 1600 + domainBoost;
  return 1200 + Math.min(domainBoost, 150);
}

function domainGuidance(domain: OraExpertiseDomain): string {
  switch (domain) {
    case "software_engineering":
      return "Act like a senior software engineer: clarify architecture, data flow, failure modes, security, performance, and implementation trade-offs. Use concise code snippets only when they materially help.";
    case "product_strategy":
      return "Act like a senior product strategist: frame the user goal, target user, core workflow, MVP boundary, risks, and the next product decision.";
    case "business_strategy":
      return "Act like a pragmatic business consultant: connect recommendations to market, customer, revenue, cost, operations, and execution constraints.";
    case "data_analysis":
      return "Act like a careful data analyst: separate observed facts from assumptions, call out data quality issues, explain the method, and avoid unsupported numeric precision.";
    case "finance":
      return "Treat this as general financial education, not personalized financial advice. State assumptions, compare options, discuss risks, and recommend a qualified professional for decisions with legal/tax/investment consequences.";
    case "legal":
      return "Treat this as general legal information, not legal advice. Explain concepts and risks plainly, avoid definitive jurisdiction-specific conclusions unless supplied, and recommend a qualified attorney for binding decisions.";
    case "health":
      return "Treat this as general health information, not medical advice. Avoid diagnosis or treatment instructions, flag urgent symptoms conservatively, and recommend a qualified clinician for personal medical decisions.";
    case "writing":
      return "Act like a strong editor: preserve the user's intent, improve clarity and structure, match the requested tone, and explain major changes when useful.";
    case "operations":
      return "Act like an operations lead: map the workflow, identify bottlenecks, define handoffs, controls, metrics, and practical rollout steps.";
    case "troubleshooting":
      return "Use a root-cause troubleshooting frame: symptoms, likely causes, checks to run, fixes in priority order, and how to verify the issue is resolved.";
    case "general":
      return "Answer as a broadly capable expert: be direct, grounded, and useful; choose structure only when it improves clarity.";
  }
}

function depthGuidance(depth: OraAnswerDepth): string {
  switch (depth) {
    case "concise":
      return "Keep the answer concise and direct. Give the key answer first, then only the minimum context needed.";
    case "standard":
      return "Give a complete answer with practical reasoning, trade-offs where relevant, and a clear next step.";
    case "expert":
      return "Give an expert-level answer: structure the response, compare viable options, surface assumptions and risks, and include a concrete recommendation. Internally check for missing edge cases before finalizing, but do not reveal hidden reasoning.";
    case "deep":
      return "Give the most thorough answer the question warrants: analyze alternatives, assumptions, edge cases, sequencing, and verification steps. Keep reasoning clear without exposing private chain-of-thought.";
  }
}

export function buildOraExpertiseProfile(input: OraExpertiseInput): OraExpertiseProfile {
  const domain = detectOraExpertiseDomain(input.message, input.topic);
  const depth = resolveOraAnswerDepth(input);
  const maxTokens = tokenBudgetFor({
    planTier: input.planTier,
    routeTier: input.routeTier,
    depth,
    domain,
    hasDocumentContext: input.hasDocumentContext,
  });

  const systemAddendum = [
    "",
    "",
    "## Answer quality profile",
    `Domain: ${domain.replace(/_/g, " ")}`,
    `Depth: ${depth}`,
    domainGuidance(domain),
    depthGuidance(depth),
    "Do not mention this internal domain/depth profile or the user's plan tier unless the user asks about routing, plans, or answer quality.",
  ].join("\n");

  return { domain, depth, maxTokens, systemAddendum };
}
