/**
 * Pure-prompt identity tests.
 *
 * These tests only inspect string content — no AI calls are made.
 * vi.mock() stubs the transitive AI-provider chain so the test runs in any
 * CI / audit shell without AI_INTEGRATIONS_* env vars.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("../../ai-providers", () => ({
  createChatCompletion: vi.fn(),
  streamChatCompletion: vi.fn(),
  ANTHROPIC_STREAM_THRESHOLD_CHARS: 15_000,
}));

vi.mock("../model-router", () => ({
  getOraProviderRoutingSnapshot: vi.fn(() => ({})),
  normalizeOraPlanTier: vi.fn(() => "free" as const),
  openAiModelForOraFile: vi.fn(() => "gpt-4o-mini"),
  openAiModelForOraRoute: vi.fn(() => "gpt-4o-mini"),
  openAiModelForOraVision: vi.fn(() => "gpt-4o-mini"),
  openAiModelForOraImage: vi.fn(() => "gpt-image-1"),
  openAiModelForOraSearch: vi.fn(() => "gpt-4o-mini"),
  openAiModelForOraMemory: vi.fn(() => "gpt-4o-mini"),
  oraImageQualityForPlan: vi.fn(() => "standard"),
  runCandidateChain: vi.fn(),
  selectOraFileModelRoute: vi.fn(() => [{ model: "gpt-4o-mini", provider: "openai", priority: 1 }]),
  selectOraMemoryModelRoute: vi.fn(() => [
    { model: "gpt-4o-mini", provider: "openai", priority: 1 },
  ]),
  selectOraVisionModelRoute: vi.fn(() => [
    { model: "gpt-4o-mini", provider: "openai", priority: 1 },
  ]),
  selectOraModelRoute: vi.fn(() => [{ model: "gpt-4o-mini", provider: "openai", priority: 1 }]),
  classifyProviderError: vi.fn(() => "unknown"),
  MODEL_DEFAULTS: { openai: { fast: "gpt-4o-mini", premium: "gpt-4o", deep: "o3-mini" } },
  isDeepSeekAvailable: vi.fn(() => false),
}));

import {
  ORA_IDENTITY_BLOCK,
  ORA_SYSTEM_PROMPT,
  ORA_SUPPORT_SYSTEM_PROMPT,
  ORA_FILE_COMPLETENESS_ADDENDUM,
} from "../prompt";
import { buildSystemPrompt } from "../../../routes/public-ai/chat";
import {
  buildTabularSystemPrompt,
  buildPresentationSystemPrompt,
  buildDocumentSystemPrompt,
} from "../file-builder";
import { LEGAL_SECTIONS } from "@workspace/ora-contracts";

describe("ORA_IDENTITY_BLOCK export", () => {
  it("is exported as a non-empty string", () => {
    expect(typeof ORA_IDENTITY_BLOCK).toBe("string");
    expect(ORA_IDENTITY_BLOCK.length).toBeGreaterThan(100);
  });

  it("names Ora as created and owned by MustaFlow AI", () => {
    expect(ORA_IDENTITY_BLOCK).toContain("MustaFlow AI");
    expect(ORA_IDENTITY_BLOCK).toContain("created and owned by MustaFlow AI");
  });

  it("includes the MustaFlow brand meaning (Must a Flow)", () => {
    expect(ORA_IDENTITY_BLOCK).toContain("Must a Flow");
  });

  it("forbids naming specific AI providers", () => {
    expect(ORA_IDENTITY_BLOCK).toContain("Do NOT name or confirm");
  });

  it("calls out OpenAI, Gemini, and Claude by name in the forbidden list", () => {
    expect(ORA_IDENTITY_BLOCK).toContain("OpenAI");
    expect(ORA_IDENTITY_BLOCK).toContain("Gemini");
    expect(ORA_IDENTITY_BLOCK).toContain("Claude");
  });

  it("tells the model to say it is powered by MustaFlow AI when asked", () => {
    expect(ORA_IDENTITY_BLOCK).toContain("powered by MustaFlow AI");
  });
});

describe("ORA_IDENTITY_BLOCK — compliance: no backend architecture disclosure", () => {
  it("does not contain 'multi-provider'", () => {
    expect(ORA_IDENTITY_BLOCK).not.toContain("multi-provider");
  });

  it("does not contain 'model stack'", () => {
    expect(ORA_IDENTITY_BLOCK).not.toContain("model stack");
  });

  it("does not contain 'specialized models'", () => {
    expect(ORA_IDENTITY_BLOCK).not.toContain("specialized models");
  });

  it("uses the safe proprietary AI systems statement", () => {
    expect(ORA_IDENTITY_BLOCK).toContain("proprietary AI systems");
  });

  it("instructs the model not to disclose routing architecture", () => {
    expect(ORA_IDENTITY_BLOCK).toContain("routing architecture");
  });
});

describe("ORA_IDENTITY_BLOCK — Ora name etymology", () => {
  it("includes the approved 'connected to time and light' phrase", () => {
    expect(ORA_IDENTITY_BLOCK).toContain("connected to time and light");
  });

  it("references the Greek hṓrā root", () => {
    expect(ORA_IDENTITY_BLOCK).toContain("hṓrā");
  });

  it("includes the Latin 'prayer' meaning", () => {
    expect(ORA_IDENTITY_BLOCK).toContain("prayer");
  });

  it("includes the Hebrew 'light' meaning", () => {
    expect(ORA_IDENTITY_BLOCK).toContain("light' in Hebrew");
  });

  it("includes the wording constraint — do not say 'Ora means hour'", () => {
    expect(ORA_IDENTITY_BLOCK).toContain("do not say");
    expect(ORA_IDENTITY_BLOCK).toContain("Ora means hour");
  });
});

describe("ORA_SYSTEM_PROMPT identity embedding", () => {
  it("embeds ORA_IDENTITY_BLOCK verbatim", () => {
    expect(ORA_SYSTEM_PROMPT).toContain(ORA_IDENTITY_BLOCK);
  });

  it("does not leak provider attribution in prose outside the identity block", () => {
    const outsideIdentity = ORA_SYSTEM_PROMPT.replace(ORA_IDENTITY_BLOCK, "");
    const leakPatterns = [
      /powered\s+by\s+(?:openai|gemini|claude|gpt|anthropic|mistral)/i,
      /built\s+(?:on|by)\s+(?:openai|google|anthropic|meta\s+ai)/i,
    ];
    for (const pattern of leakPatterns) {
      expect(pattern.test(outsideIdentity)).toBe(false);
    }
  });
});

describe("ORA_SUPPORT_SYSTEM_PROMPT identity embedding", () => {
  it("embeds ORA_IDENTITY_BLOCK verbatim", () => {
    expect(ORA_SUPPORT_SYSTEM_PROMPT).toContain(ORA_IDENTITY_BLOCK);
  });

  it("contains MustaFlow AI in the identity section", () => {
    expect(ORA_SUPPORT_SYSTEM_PROMPT).toContain("MustaFlow AI");
  });
});

describe("ORA_FILE_COMPLETENESS_ADDENDUM", () => {
  it("is exported and contains completeness rules", () => {
    expect(typeof ORA_FILE_COMPLETENESS_ADDENDUM).toBe("string");
    expect(ORA_FILE_COMPLETENESS_ADDENDUM).toContain("COMPLETENESS RULES");
  });

  it("forbids placeholders and ellipsis gaps", () => {
    expect(ORA_FILE_COMPLETENESS_ADDENDUM).toContain("placeholder");
    expect(ORA_FILE_COMPLETENESS_ADDENDUM).toContain("...");
  });

  it("forbids silent truncation", () => {
    expect(ORA_FILE_COMPLETENESS_ADDENDUM).toContain("silently truncate");
  });

  it("requires completeness validation before responding", () => {
    expect(ORA_FILE_COMPLETENESS_ADDENDUM).toContain("Validate before responding");
  });
});

describe("buildSystemPrompt identity propagation", () => {
  it("includes ORA_IDENTITY_BLOCK for anonymous users (no language)", () => {
    const prompt = buildSystemPrompt(undefined, undefined, false);
    expect(prompt).toContain(ORA_IDENTITY_BLOCK);
  });

  it("includes ORA_IDENTITY_BLOCK for signed-in users (no language)", () => {
    const prompt = buildSystemPrompt(undefined, undefined, true);
    expect(prompt).toContain(ORA_IDENTITY_BLOCK);
  });

  it("includes ORA_IDENTITY_BLOCK when language is set to Arabic", () => {
    const prompt = buildSystemPrompt("ar", undefined, true);
    expect(prompt).toContain(ORA_IDENTITY_BLOCK);
    expect(prompt).toContain("ar");
  });

  it("includes ORA_IDENTITY_BLOCK with browser language hint (fr-FR)", () => {
    const prompt = buildSystemPrompt(undefined, "fr-FR", false);
    expect(prompt).toContain(ORA_IDENTITY_BLOCK);
  });

  it("includes MustaFlow AI in every buildSystemPrompt output path", () => {
    const paths = [
      buildSystemPrompt(undefined, undefined, false),
      buildSystemPrompt(undefined, undefined, true),
      buildSystemPrompt("es", undefined, true),
      buildSystemPrompt(undefined, "ar-SA", false),
    ];
    for (const p of paths) {
      expect(p).toContain("MustaFlow AI");
    }
  });

  it("injects the authoritative current date/time block into every path", () => {
    const paths = [
      buildSystemPrompt(undefined, undefined, false),
      buildSystemPrompt(undefined, undefined, true),
      buildSystemPrompt("es", undefined, true),
      buildSystemPrompt(undefined, "ar-SA", false),
      buildSystemPrompt(undefined, undefined, true, "America/New_York"),
    ];
    for (const p of paths) {
      expect(p).toContain("## Current date and time (authoritative)");
      expect(p).toContain("UTC timestamp:");
      expect(p).toContain("Never infer or guess the current date or time");
    }
  });

  it("passes the caller's timezone into the date block", () => {
    const prompt = buildSystemPrompt(undefined, undefined, true, "America/New_York");
    expect(prompt).toContain("America/New_York");
  });
});

describe("file-builder system prompts — identity embedding", () => {
  it("buildTabularSystemPrompt (csv) includes ORA_IDENTITY_BLOCK", () => {
    const prompt = buildTabularSystemPrompt("csv");
    expect(prompt).toContain(ORA_IDENTITY_BLOCK);
  });

  it("buildTabularSystemPrompt (xlsx) includes ORA_IDENTITY_BLOCK", () => {
    const prompt = buildTabularSystemPrompt("xlsx");
    expect(prompt).toContain(ORA_IDENTITY_BLOCK);
  });

  it("buildPresentationSystemPrompt includes ORA_IDENTITY_BLOCK", () => {
    const prompt = buildPresentationSystemPrompt();
    expect(prompt).toContain(ORA_IDENTITY_BLOCK);
  });

  it("buildDocumentSystemPrompt (docx) includes ORA_IDENTITY_BLOCK", () => {
    const prompt = buildDocumentSystemPrompt("docx");
    expect(prompt).toContain(ORA_IDENTITY_BLOCK);
  });

  it("buildDocumentSystemPrompt (pdf) includes ORA_IDENTITY_BLOCK", () => {
    const prompt = buildDocumentSystemPrompt("pdf");
    expect(prompt).toContain(ORA_IDENTITY_BLOCK);
  });

  it("buildTabularSystemPrompt also retains ORA_FILE_COMPLETENESS_ADDENDUM", () => {
    const prompt = buildTabularSystemPrompt("csv");
    expect(prompt).toContain(ORA_FILE_COMPLETENESS_ADDENDUM);
  });

  it("buildPresentationSystemPrompt also retains ORA_FILE_COMPLETENESS_ADDENDUM", () => {
    const prompt = buildPresentationSystemPrompt();
    expect(prompt).toContain(ORA_FILE_COMPLETENESS_ADDENDUM);
  });

  it("buildDocumentSystemPrompt also retains ORA_FILE_COMPLETENESS_ADDENDUM", () => {
    const prompt = buildDocumentSystemPrompt("docx");
    expect(prompt).toContain(ORA_FILE_COMPLETENESS_ADDENDUM);
  });
});

describe("LEGAL_SECTIONS — shared web + mobile brand-safe legal copy", () => {
  it("has no heading called 'Third-party AI'", () => {
    const headings = LEGAL_SECTIONS.map((s) => s.heading);
    expect(headings).not.toContain("Third-party AI");
  });

  it("includes a 'Service processing' section replacing the old 'Third-party AI' heading", () => {
    const headings = LEGAL_SECTIONS.map((s) => s.heading);
    expect(headings).toContain("Service processing");
  });

  it("no body contains 'generated by AI models'", () => {
    for (const section of LEGAL_SECTIONS) {
      expect(section.body).not.toContain("generated by AI models");
    }
  });

  it("no body contains 'third-party AI' (case-insensitive)", () => {
    for (const section of LEGAL_SECTIONS) {
      expect(section.body.toLowerCase()).not.toContain("third-party ai");
    }
  });

  it("no body contains 'AI providers'", () => {
    for (const section of LEGAL_SECTIONS) {
      expect(section.body).not.toContain("AI providers");
    }
  });

  it("'How Ora works' body credits MustaFlow AI as creator", () => {
    const section = LEGAL_SECTIONS.find((s) => s.heading === "How Ora works");
    expect(section?.body).toContain("MustaFlow AI");
  });

  it("'Service processing' body uses trusted-infrastructure language (not provider names)", () => {
    const section = LEGAL_SECTIONS.find((s) => s.heading === "Service processing");
    expect(section?.body).toContain("trusted infrastructure");
    expect(section?.body).not.toContain("AI providers");
  });

  it("Contact section references support@mustaflow.com", () => {
    const section = LEGAL_SECTIONS.find((s) => s.heading === "Contact");
    expect(section?.body).toContain("support@mustaflow.com");
  });
});
