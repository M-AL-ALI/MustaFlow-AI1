import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(path.join(__dirname, rel), "utf8");
const collapse = (s: string) => s.replace(/\s+/g, " ");

/**
 * Help Center & support must NOT look like an AI Builder feature.
 *
 * Two contracts, guarded with static source assertions (the repo convention for
 * heavily-dependent layout/route wiring):
 *   1. The Builder slide-out nav does not expose the private support-ticket
 *      index. Its Help & Support entry opens the neutral /help surface instead.
 *   2. Help/support routes render the neutral HelpLayout, never AppLayout (which
 *      mounts the Builder SlideOutNav for signed-in users).
 */
describe("Help/support is not an AI Builder feature", () => {
  const slideOutNav = read("../slide-out-nav.tsx");
  const app = read("../../../App.tsx");
  const flatApp = collapse(app);

  it("(#2) the Builder slide-out nav has no support-tickets entry", () => {
    expect(slideOutNav).not.toContain("/support/tickets");
    expect(slideOutNav).not.toContain("Support tickets");
  });

  it("(#3) /help and /help/domains-api render HelpLayout, not AppLayout", () => {
    expect(flatApp).toContain("<HelpLayout> <HelpPage /> </HelpLayout>");
    expect(flatApp).toContain("<HelpLayout> <HelpDomainsApiPage /> </HelpLayout>");
    expect(flatApp).not.toContain("<AppLayout> <HelpPage />");
    expect(flatApp).not.toContain("<AppLayout> <HelpDomainsApiPage />");
  });

  it("(#3) support ticket routes render HelpLayout, not AppLayout", () => {
    expect(flatApp).toContain("<HelpLayout> <SupportTicketsPage /> </HelpLayout>");
    expect(flatApp).not.toContain("<AppLayout> <SupportTicketsPage />");
  });

  it("(#3) HelpLayout does not mount the Builder SlideOutNav", () => {
    const helpLayout = read("../help-layout.tsx");
    expect(helpLayout).not.toContain("SlideOutNav");
  });
});
