import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { NAV_ITEMS } from "../slide-out-nav";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(path.join(__dirname, rel), "utf8");
const collapse = (source: string) => source.replace(/\s+/g, " ");

describe("Builder Help & Support reachability", () => {
  it("keeps one signed-in Builder drawer entry wired to /help", () => {
    const helpItems = NAV_ITEMS.filter((item) => item.href === "/help");

    expect(helpItems).toHaveLength(1);
    expect(helpItems[0]?.name).toBe("Help & Support");
    expect(helpItems[0]?.icon).toBeTruthy();
    expect(NAV_ITEMS.at(-1)?.href).toBe("/help");
  });

  it("keeps /help registered in both the full and signed-out applications", () => {
    const app = collapse(read("../../../App.tsx"));
    const publicApp = collapse(read("../../../PublicApp.tsx"));

    expect(app).toContain('<Route path="/help"> <HelpLayout> <HelpPage /> </HelpLayout>');
    expect(publicApp).toContain('<Route path="/help" component={HelpPage} />');
  });

  it("keeps the Help surface intentionally usable in both user states", () => {
    const helpLayout = collapse(read("../help-layout.tsx"));
    const helpPage = collapse(read("../../../pages/help.tsx"));

    expect(helpLayout).toContain("if (!isSignedIn)");
    expect(helpLayout).toContain("<PublicHeader />");
    expect(helpLayout).toContain("Help &amp; Support");
    expect(helpPage).toContain('href="mailto:support@mustaflow.com"');
    expect(helpPage).toContain("Ask Ora — Support");
    expect(helpPage).toContain("Escalate to our support team");
  });
});
