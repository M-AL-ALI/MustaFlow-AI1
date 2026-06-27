import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(path.join(__dirname, rel), "utf8");

describe("Website Ora Settings — Account sync wiring", () => {
  const settings = read("../ora-settings.tsx");
  const route = read("../../../../api-server/src/routes/ora-account-consistency.ts");
  const routesIndex = read("../../../../api-server/src/routes/index.ts");

  it("renders an Account sync section that calls the protected endpoint via authFetch", () => {
    expect(settings).toContain("function AccountSyncSection()");
    expect(settings).toContain('title="Account sync"');
    expect(settings).toContain('authFetch("/api/ora/account-consistency")');
    expect(settings).toContain("<AccountSyncSection />");
  });

  it("renders identity, plan, counts, and API fields from the diagnostics response", () => {
    expect(settings).toContain("diag.identity.userIdHash");
    expect(settings).toContain("diag.identity.clerkUserIdLast4");
    expect(settings).toContain("diag.identity.email");
    expect(settings).toContain("diag.billing.billingTier");
    expect(settings).toContain("diag.chatSession.tier");
    expect(settings).toContain("diag.counts.conversations");
    expect(settings).toContain("diag.counts.projects");
    expect(settings).toContain("diag.counts.userLevelMemories");
    expect(settings).toContain("diag.counts.projectMemories");
    expect(settings).toContain("diag.counts.assets");
    expect(settings).toContain("diag.counts.supportTickets");
    expect(settings).toContain("diag.api.host");
    expect(settings).toContain("diag.api.environment");
  });

  it("warns when billing plan does not match the resolved chat plan", () => {
    expect(settings).toContain("tierMismatch");
  });

  it("backend endpoint exists and is mounted under the /ora prefix", () => {
    expect(route).toContain('"/ora/account-consistency"');
    expect(route).toContain("userIdHash");
    expect(routesIndex).toContain("oraAccountConsistencyRouter");
  });

  it("does not leak the raw user id (only a hash + last4)", () => {
    // The handler must never return req.userId verbatim in the response body.
    expect(route).not.toMatch(/userId:\s*req\.userId/);
    expect(route).toContain("createHash");
  });
});
