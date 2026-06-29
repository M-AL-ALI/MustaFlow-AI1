import { describe, expect, it } from "vitest";
import {
  ORA_IDENTITY_BLOCK,
  ORA_SYSTEM_PROMPT,
  ORA_SUPPORT_SYSTEM_PROMPT,
  ORA_FILE_COMPLETENESS_ADDENDUM,
} from "../prompt";
import { buildSystemPrompt } from "../../../routes/public-ai/chat";

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
});
