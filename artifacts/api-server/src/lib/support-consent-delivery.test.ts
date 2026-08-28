import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  supportAccessRequestTemplate,
  supportClassificationTemplate,
  supportProposalReadyTemplate,
} from "./emailTemplates";

function source(relative: string): string {
  return readFileSync(new URL(relative, import.meta.url), "utf8");
}

describe("support consent and delivery", () => {
  it("creates one idempotent durable cross-channel receipt schema", () => {
    const migration = source("./startup-migrations.ts");
    const schema = source("../../../../lib/db/src/schema/support-operations.ts");
    for (const body of [migration, schema]) {
      expect(body).toContain("support_user_deliveries");
      expect(body).toContain("access_request");
      expect(body).toContain("proposal_ready");
      expect(body).toContain("ticket_classified");
      expect(body).toContain("ticket_reply");
      expect(body).toContain("external_guidance");
      expect(body).toContain("email_status");
    }
    const supportMigration = migration.slice(
      migration.indexOf("export async function applySupportOperationsMigration"),
      migration.indexOf("export async function applyZeroTerminalMigration"),
    );
    expect(supportMigration).toContain("CREATE TABLE IF NOT EXISTS support_user_deliveries");
    expect(supportMigration).not.toMatch(/\b(DROP\s+TABLE|TRUNCATE\s+TABLE|DELETE\s+FROM)\b/iu);
  });

  it("persists the in-product fact before email and records the truthful outcome", () => {
    const delivery = source("./support-user-delivery.ts");
    expect(delivery.indexOf("db.transaction")).toBeLessThan(
      delivery.indexOf("const providerStatus"),
    );
    expect(delivery).toContain("notificationsTable");
    expect(delivery).toContain("supportUserDeliveriesTable");
    expect(delivery).toContain('providerStatus === "sent" ? "sent" : "failed"');
    expect(delivery).toContain("Email delivery is not configured.");
    expect(delivery).toContain("The email provider did not accept the message.");
    expect(delivery).not.toContain('emailStatus: "delivered"');
  });

  it("delivers access, proposal, classification and reply consequences through one helper", () => {
    const access = source("../routes/support-access.ts");
    const messages = source("../routes/messages.ts");
    const operations = source("../routes/support-operations.ts");
    const admin = source("../routes/admin-support.ts");
    expect(access).toContain('kind: "access_request"');
    expect(messages).toContain('kind: "proposal_ready"');
    expect(operations).toContain('"ticket_classified"');
    expect(operations).toContain('"external_guidance"');
    expect(admin).toContain('kind: "ticket_reply"');
    for (const body of [access, messages, operations, admin]) {
      expect(body).toContain("deliverSupportConsequence");
    }
  });

  it("expires unanswered access requests and never turns expiry into consent", () => {
    const accessRoute = source("../routes/support-access.ts");
    const accessContract = source("./support-access.ts");
    expect(accessRoute).toContain("requestExpiresAt");
    expect(accessRoute).toContain("grant_expired_before_new_request");
    expect(accessRoute).toContain("lte(supportAccessGrantsTable.expiresAt, now)");
    expect(accessRoute).toContain("This access request has expired. Nothing was granted.");
    expect(accessContract).toContain('(grant.status === "active" || grant.status === "pending")');
  });

  it("keeps email links non-authorizing and escapes user-controlled HTML", () => {
    const access = supportAccessRequestTemplate({
      ticketId: 12,
      projectName: "<Project>",
      staffName: "<Staff>",
      reason: "<Reason>",
      requestExpiresAt: new Date("2026-08-28T12:00:00.000Z"),
      decisionUrl: "https://www.mustaflow.com/support/tickets/12",
    });
    expect(access.html).toContain("&lt;Project&gt;");
    expect(access.html).toContain("&lt;Staff&gt;");
    expect(access.html).toContain("&lt;Reason&gt;");
    expect(access.html).not.toContain("<Project>");
    expect(access.text).toContain("Opening this link does not grant access");

    const proposal = supportProposalReadyTemplate({
      ticketId: 12,
      projectName: "<Project>",
      staffName: "<Staff>",
      summary: "<Summary>",
      decisionUrl: "https://www.mustaflow.com/support/tickets/12",
    });
    expect(proposal.html).toContain("&lt;Summary&gt;");
    expect(proposal.text).toContain("Nothing has changed");

    const classification = supportClassificationTemplate({
      ticketId: 12,
      subject: "<Subject>",
      classification: "external",
      explanation: "<Explanation>",
      ticketUrl: "https://www.mustaflow.com/support/tickets/12",
    });
    expect(classification.html).toContain("&lt;Subject&gt;");
    expect(classification.html).toContain("&lt;Explanation&gt;");
  });

  it("keeps owner history project-scoped and bounded", () => {
    const access = source("../routes/support-access.ts");
    expect(access).toContain('router.get("/support/projects/:id/access-history"');
    expect(access).toContain("eq(projectsTable.ownerId, req.userId!)");
    expect(access).toContain("isNull(projectsTable.deletedAt)");
    expect(access).toContain(".limit(50)");
    expect(access).toContain(".limit(500)");
    expect(access).toContain('res.status(404).json({ error: "Project not found." })');
  });

  it("keeps internal notes outside every user delivery path", () => {
    const admin = source("../routes/admin-support.ts");
    const internalNoteStart = admin.indexOf('router.post("/admin/support-tickets/:id/note"');
    expect(internalNoteStart).toBeGreaterThan(-1);
    const nextRoute = admin.indexOf("router.", internalNoteStart + 20);
    const internalNoteRoute = admin.slice(
      internalNoteStart,
      nextRoute === -1 ? admin.length : nextRoute,
    );
    expect(internalNoteRoute).not.toContain("deliverSupportConsequence");
    expect(internalNoteRoute).not.toContain("sendEmail");
  });
});
