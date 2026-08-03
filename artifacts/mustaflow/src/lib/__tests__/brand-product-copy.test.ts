import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = resolve(__dirname, "../../../../..");

const builderCopyFiles = [
  "artifacts/mustaflow/index.html",
  "artifacts/mustaflow/public.html",
  "artifacts/mustaflow/public/llms.txt",
  "artifacts/mustaflow/scripts/prerender.ts",
  "artifacts/mustaflow/src/pages/home.tsx",
  "artifacts/mustaflow/src/pages/community.tsx",
  "artifacts/mustaflow/src/pages/developers.tsx",
  "artifacts/mustaflow/src/pages/pricing.tsx",
  "artifacts/mustaflow/src/pages/u.tsx",
  "artifacts/mustaflow/src/components/ora-panel.tsx",
  "artifacts/mustaflow/src/components/ora-bubble.tsx",
  "artifacts/api-server/src/lib/brainstorm.ts",
  "artifacts/api-server/src/lib/builder.ts",
  "artifacts/api-server/src/lib/ai.ts",
  "artifacts/api-server/src/lib/agent-loop.ts",
  "artifacts/api-server/src/lib/serveSnapshot.ts",
  "artifacts/api-server/src/routes/profiles.ts",
  "artifacts/api-server/src/lib/public-ai/classifier.ts",
  "artifacts/api-server/src/lib/public-ai/prompt.ts",
  "artifacts/api-server/src/lib/emailTemplates.ts",
  "artifacts/ora-mobile/app/(home)/index.tsx",
  "lib/db/src/help-center-seed.ts",
] as const;

function read(relativePath: string): string {
  return readFileSync(resolve(REPO_ROOT, relativePath), "utf8");
}

describe("company and product display-copy boundaries", () => {
  it("uses NabuFlow for app-builder product copy", () => {
    const builderCopy = builderCopyFiles.map(read).join("\n");

    expect(builderCopy).toContain("NabuFlow");
    expect(builderCopy).not.toMatch(/Built with MustaFlow/i);
    expect(builderCopy).not.toMatch(/MustaFlow AI Builder/i);
    expect(builderCopy).not.toMatch(/MustaFlow (?:plans|builds|ships|handles|preserves|enforces)/i);
    expect(builderCopy).not.toMatch(/MustaFlow (?:public )?(?:REST )?API/i);
    expect(builderCopy).not.toContain("What is MustaFlow?");
  });

  it("keeps MustaFlow AI Technology as the company behind NabuFlow, Ora, and Orax", () => {
    const oraPrompt = read("artifacts/api-server/src/lib/public-ai/prompt.ts");
    const oraContract = read("lib/ora-contracts/src/index.ts");
    const oraxSetup = read("artifacts/orax-desktop/src/renderer/pages/SetupScreen.tsx");

    expect(oraPrompt).toContain("MustaFlow AI Technology is the company");
    expect(oraPrompt).toContain("owns NabuFlow and Orax");
    expect(oraContract).toContain("Ora is an AI assistant created and powered by MustaFlow AI");
    expect(oraxSetup).toContain("Orax Desktop lets MustaFlow AI work with projects");
  });

  it("keeps support ticket auto-replies company-branded rather than builder-branded", () => {
    const emailTemplates = read("artifacts/api-server/src/lib/emailTemplates.ts");
    const confirmationStart = emailTemplates.indexOf("supportTicketConfirmationTemplate");
    const confirmationEnd = emailTemplates.indexOf("supportReplyTemplate", confirmationStart);
    const confirmationTemplate = emailTemplates.slice(confirmationStart, confirmationEnd);

    expect(confirmationStart).toBeGreaterThan(-1);
    expect(confirmationEnd).toBeGreaterThan(confirmationStart);
    expect(confirmationTemplate).toContain("MustaFlow support");
    expect(confirmationTemplate).not.toContain("NabuFlow");
  });
});
