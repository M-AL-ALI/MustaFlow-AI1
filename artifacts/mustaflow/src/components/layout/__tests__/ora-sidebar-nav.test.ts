/**
 * Help Center navigation wiring (Task #1312 user-facing surface).
 *
 * Proves the Ora sidebar exposes the three Help Center destinations with the
 * exact hrefs the rest of the app routes on:
 * - Help Center        -> /help
 * - Report Issue       -> /help?mode=report  (opens the escalation form)
 * - My Support Tickets -> /support/tickets
 */

import { describe, it, expect } from "vitest";
import { NAV_ITEMS } from "../ora-sidebar";

function hrefFor(name: string): string | undefined {
  return NAV_ITEMS.find((i) => i.name === name)?.href;
}

describe("Ora sidebar Help Center navigation", () => {
  it("links Help Center to /help", () => {
    expect(hrefFor("Help Center")).toBe("/help");
  });

  it("links Report Issue to /help?mode=report", () => {
    expect(hrefFor("Report Issue")).toBe("/help?mode=report");
  });

  it("links My Support Tickets to /support/tickets", () => {
    expect(hrefFor("My Support Tickets")).toBe("/support/tickets");
  });

  it("each Help Center item ships a lucide icon component (no emoji)", () => {
    for (const name of ["Help Center", "Report Issue", "My Support Tickets"]) {
      const item = NAV_ITEMS.find((i) => i.name === name);
      expect(item).toBeDefined();
      // lucide-react icons are React components (function or forwardRef object).
      const icon = item!.icon as unknown;
      expect(icon).toBeTruthy();
      expect(["function", "object"]).toContain(typeof icon);
    }
  });
});
