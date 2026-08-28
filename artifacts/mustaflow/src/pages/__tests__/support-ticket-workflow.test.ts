import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function source(relative: string): string {
  return readFileSync(new URL(relative, import.meta.url), "utf8");
}

describe("support ticket workflow surfaces", () => {
  it("shows one canonical ticket number to the user and staff", () => {
    const inbox = source("../support-inbox.tsx");
    const tickets = source("../support-tickets.tsx");
    const help = source("../help.tsx");
    const consoleSource = source("../support-operation-console.tsx");
    expect(inbox).toContain("ticket.ticketNumber");
    expect(tickets.match(/ticketNumber/g)?.length).toBeGreaterThanOrEqual(2);
    expect(help).toContain("res.ticketNumber");
    expect(consoleSource).toContain("Support ticket ${ticketNumber}");
    expect(help).not.toContain("Ticket #${res.ticketId}");
  });

  it("makes assignee, age and priority visible on every staff list item", () => {
    const inbox = source("../support-inbox.tsx");
    expect(inbox).toContain("formatAge(ticket.ageMinutes)");
    expect(inbox).toContain("priorityBadgeClass(ticket.priority)");
    expect(inbox).toContain('assigneeName ?? "Unassigned"');
    expect(inbox).toContain('aria-label="Ticket priority"');
    expect(inbox).toContain('aria-label="Ticket assignee"');
  });

  it("exposes all five honest states without a direct resolved control", () => {
    const inbox = source("../support-inbox.tsx");
    expect(inbox).toContain('value: "waiting_on_user"');
    expect(inbox).toContain('value: "blocked_on_third_party"');
    expect(inbox).toContain('value: "resolved"');
    expect(inbox).toContain('["new", "open", "waiting_on_user"] as const');
    expect(inbox).not.toContain('["new", "open", "resolved"] as const');
  });
});
