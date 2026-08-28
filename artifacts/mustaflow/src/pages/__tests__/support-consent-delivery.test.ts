import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function source(relative: string): string {
  return readFileSync(new URL(relative, import.meta.url), "utf8");
}

describe("support consent and delivery surfaces", () => {
  it("puts a pending support request and recent receipt inside the owner's project", () => {
    const panel = source("../projects/components/project-support-access.tsx");
    const workspace = source("../projects/[id].tsx");
    expect(workspace).toContain("<ProjectSupportAccess projectId={projectId} />");
    expect(panel).toContain("is requesting temporary access");
    expect(panel).toContain("Grant one hour");
    expect(panel).toContain("Refuse");
    expect(panel).toContain("Revoke now");
    expect(panel).toContain("Recent support access");
    expect(panel).toContain("Request expires");
  });

  it("routes support notifications back to the authenticated ticket surface", () => {
    const bell = source("../../components/notifications-bell.tsx");
    expect(bell).toContain('case "support_access_requested"');
    expect(bell).toContain('case "support_proposal_ready"');
    expect(bell).toContain('case "support_ticket_reply"');
    expect(bell).toContain('case "support_ticket_classified"');
    expect(bell).toContain("/support/tickets/${ticketId}");
  });

  it("shows durable email outcomes to both operator and owner", () => {
    const inbox = source("../support-inbox.tsx");
    const operator = source("../support-operation-console.tsx");
    const owner = source("../support-owner-actions.tsx");
    expect(inbox).toContain("presentSupportEmailStatus(deliveryStatus)");
    expect(inbox).toContain("Reply saved, and the email provider accepted the message.");
    expect(operator).toContain("User delivery receipts");
    expect(operator).toContain("delivery.emailStatus");
    expect(owner).toContain("How support contacted you");
    expect(owner).toContain("delivery.emailStatus");
  });

  it("uses human words without claiming provider delivery it cannot prove", () => {
    const operator = source("../support-operation-console.tsx");
    const owner = source("../support-owner-actions.tsx");
    const contract = source("../../lib/support-operations.ts");
    expect(operator).toContain("presentSupportEmailStatus(delivery.emailStatus)");
    expect(owner).toContain("presentSupportEmailStatus(delivery.emailStatus)");
    expect(contract).toContain('return "email accepted by provider"');
    expect(contract).toContain('return "email delivered"');
    expect(operator).not.toContain("Email delivered");
    expect(owner).not.toContain("Email delivered");
  });
});
