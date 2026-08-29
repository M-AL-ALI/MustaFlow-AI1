import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function source(relative: string): string {
  return readFileSync(new URL(relative, import.meta.url), "utf8");
}

describe("support resolution and presence surfaces", () => {
  it("shows exactly three honest triage choices and their required details", () => {
    const consoleSource = source("../support-operation-console.tsx");
    expect(consoleSource).toContain("Project issue");
    expect(consoleSource).toContain("NabuFlow platform issue");
    expect(consoleSource).toContain("Outside NabuFlow");
    expect(consoleSource).toContain("Stable affected-path signature");
    expect(consoleSource).toContain("Exact steps the user should take there");
  });

  it("runs a read-only Zero proposal before exposing owner approval and mutation", () => {
    const operator = source("../support-operation-console.tsx");
    const owner = source("../support-owner-actions.tsx");
    expect(operator).toContain("Ask Zero for a proposal");
    expect(operator).toContain("planMode: true");
    expect(operator).toContain('agentIntent: "plan"');
    expect(operator).toContain("Start approved change");
    expect(operator).toContain("planMode: false");
    expect(operator).toContain('agentIntent: "mutate"');
    expect(owner).toContain("Approve proposed change");
    expect(owner).toContain("Decline change");
    expect(owner).toContain("Nothing changes until you approve");
  });

  it("renders named defect impact and refuses a typed-only shipped claim", () => {
    const operator = source("../support-operation-console.tsx");
    const inbox = source("../support-inbox.tsx");
    expect(operator).toContain("affectedAccountCount");
    expect(operator).toContain("affectedAccounts.join");
    expect(operator).toContain("Verify shipped fix");
    expect(operator).toContain("onMutated();");
    expect(inbox).toMatch(/<SupportOperationConsole[\s\S]{0,200}onMutated=\{onMutated\}/u);
    expect(operator).toContain("/api/admin/support-defects/${defect.id}/verify");
    expect(operator).not.toContain("status: 200");
    expect(operator).not.toContain("observedAt: new Date().toISOString()");
  });

  it("uses one named, pictured presence surface for staff and teammates", () => {
    const presence = source("../projects/components/project-presence.tsx");
    const workspace = source("../projects/[id].tsx");
    expect(presence).toContain("peer.imageUrl");
    expect(presence).toContain("peer.name");
    expect(presence).toContain("peer.location");
    expect(presence).toContain("NabuFlow Support");
    expect(presence).toContain("Collaborator");
    expect(presence).not.toContain("Revoke access now");
    expect(presence).toContain("Revoke ${peer.name}'s support access");
    expect(presence).toContain("WORKSPACE_TOOLS.find");
    expect(workspace).toContain("workspacePresenceLocation(activeTab)");
  });

  it("keeps the full grant receipt and the owner's external-blocker control visible", () => {
    const owner = source("../support-owner-actions.tsx");
    const tickets = source("../support-tickets.tsx");
    expect(owner).toContain("Full support access receipt #");
    expect(owner).toContain("event.actorDisplayName");
    expect(owner).toContain("receiptDetailLines(event)");
    expect(owner).not.toContain("JSON.stringify(event.detail)");
    expect(owner).toContain("I fixed it with the third party");
    expect(owner).toContain('operations.ticket.status === "blocked_on_third_party"');
    expect(owner).not.toContain('operations.ticket.status === "blocked"');
    expect(owner).toContain("await onMutated();");
    expect(tickets).toContain(
      "<SupportOwnerActions ticketId={ticketId} onMutated={() => refetch()} />",
    );
  });
});
