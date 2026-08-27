import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY ?? Buffer.alloc(32, 11).toString("base64");
process.env.DATABASE_URL = process.env.DATABASE_URL ?? "postgres://test:test@127.0.0.1:1/test";

function source(relative: string): string {
  return readFileSync(new URL(relative, import.meta.url), "utf8");
}

describe("consented support operations", () => {
  it("ends a support session at an expired, revoked, declined or closed grant", async () => {
    const { effectiveSupportGrantStatus } = await import("./support-access");
    const now = new Date("2026-08-27T12:00:00.000Z");
    expect(
      effectiveSupportGrantStatus(
        { status: "active", expiresAt: new Date("2026-08-27T12:00:01.000Z") },
        now,
      ),
    ).toBe("active");
    expect(
      effectiveSupportGrantStatus(
        { status: "active", expiresAt: new Date("2026-08-27T12:00:00.000Z") },
        now,
      ),
    ).toBe("expired");
    for (const status of ["declined", "revoked", "expired", "closed"] as const) {
      expect(effectiveSupportGrantStatus({ status, expiresAt: null }, now)).not.toBe("active");
    }
  });

  it("creates the support schema idempotently without destructive SQL", async () => {
    const { applySupportOperationsMigration } = await import("./startup-migrations");
    const statements: string[] = [];
    const client = {
      query: async (statement: string) => {
        statements.push(statement.replace(/\s+/g, " ").trim());
        return { rows: [], rowCount: 0 };
      },
    } as unknown as Parameters<typeof applySupportOperationsMigration>[0];
    await applySupportOperationsMigration(client);
    const first = [...statements];
    statements.length = 0;
    await applySupportOperationsMigration(client);
    expect(statements).toEqual(first);
    expect(first.join("\n")).toContain("CREATE TABLE IF NOT EXISTS support_access_grants");
    expect(first.join("\n")).toContain("CREATE TABLE IF NOT EXISTS support_zero_sessions");
    expect(first.join("\n")).toContain("DEFAULT 'diagnosing'");
    expect(first.join("\n")).toContain("'diagnosing','proposal_ready','approved'");
    expect(first.join("\n")).toContain("CREATE TABLE IF NOT EXISTS platform_defects");
    expect(first.join("\n")).not.toMatch(/\b(DROP\s+TABLE|TRUNCATE\s+TABLE|DELETE\s+FROM)\b/i);
  });

  it("diagnoses read-only before the owner can approve one exact mutation", () => {
    const messages = source("../routes/messages.ts");
    const supportAccess = source("./support-access.ts");
    const operations = source("../routes/support-operations.ts");
    expect(messages).toContain("readSupportProposalRun(input)");
    expect(messages).toContain("readApprovedSupportMutation(input)");
    expect(messages).toContain("actorUserId: req.userId!");
    expect(messages).toContain("requireProjectOwnerOrApprovedSupportOperator");
    expect(supportAccess).toContain("session.staffUserId !== input.actorUserId");
    expect(supportAccess).toContain('["owner", "operator", "support"].includes(principal.role)');
    expect(messages).toContain("content !== supportRun.instruction");
    expect(messages).toContain("const authoritativeExplicitAgentIntent = supportProposal");
    expect(messages).toContain('? "plan"');
    expect(messages).toContain("`support-proposal:${supportProposal.sessionId}`");
    expect(messages).toContain('code: "support_global_pause"');
    expect(messages).toContain("`support-session:${supportMutation.sessionId}`");
    expect(messages).toContain("provenanceActorUserId: supportRun?.staffUserId ?? null");
    expect(messages).toContain("provenanceActorUserId: supportMutation?.staffUserId ?? null");
    expect(messages).toContain("provenanceActorUserId: supportMutation?.staffUserId");
    expect(messages).toContain("readSupportEvidenceImages(supportRun)");
    expect(messages).toContain("getOraAssetBytes(assetId, mutation.ownerUserId)");
    expect(operations).toContain("The complete support evidence follows as structured JSON");
    expect(operations).toContain("Do not write, delete, move, publish, or otherwise mutate");
    expect(operations).toContain('row.session.status !== "proposal_ready"');
    expect(operations).toContain('decision: z.enum(["approve", "decline"])');
  });

  it("rechecks consent before every normal project-file commit and in the durable job payload", () => {
    const jobs = source("./jobs.ts");
    expect(jobs).toContain("supportSessionId?: number");
    expect(jobs).toContain("supportSessionId: input.supportSessionId ?? null");
    expect(jobs).toContain("provenanceActorUserId?: string");
    expect(jobs).toContain("provenanceActorUserId: input.provenanceActorUserId ?? null");
    expect(jobs).toContain(
      "const provenanceActorUserId = input.provenanceActorUserId ?? project.ownerId",
    );
    expect(jobs.match(/actorUserId: provenanceActorUserId/g)).toHaveLength(2);
    expect(
      jobs.match(/actorUserId: task\.provenanceActorUserId \?\? project\.ownerId/g),
    ).toHaveLength(2);
    expect(jobs).toContain("needsFix && !isArchitectAutoFix && !input.supportSessionId");
    expect(jobs).toContain("hasMomentNotice && !input.supportSessionId");
    expect(jobs).toContain("!isAutoFixTask &&\n                !input.supportSessionId");
    expect(jobs.match(/await assertSupportGrantStillAuthorizesMutation\(\);/g)).toHaveLength(5);
    expect(jobs).toContain('event: applied ? "zero_change_applied" : "zero_change_interrupted"');
  });

  it("makes ticket closure proof-bearing and all three classes explicit", () => {
    const route = source("../routes/support-operations.ts");
    const admin = source("../routes/admin-support.ts");
    expect(route).toContain('z.literal("project")');
    expect(route).toContain('z.literal("platform")');
    expect(route).toContain('z.literal("external")');
    expect(route).toContain("support_project_proof_required");
    expect(route).toContain('mutationTerminal.evidence.preview.state !== "ready"');
    expect(route).toContain(
      "mutationTerminal.evidence.preview.receiptId !== `version:${session.appliedVersionId}`",
    );
    expect(route).toContain("gt(previewSnapshotsTable.expiresAt, new Date())");
    expect(route).toContain("support_platform_fix_shipped");
    expect(route).toContain("support_blocked_external");
    expect(route).toContain("getServedBuildIdentity");
    expect(route).toContain("support_live_build_mismatch");
    expect(route).toContain('"/admin/support-defects/:id/verify"');
    expect(route).toContain("proveCurrentNabuFlowRoute(req, parsed.data.probe.route)");
    expect(route).toContain("support_live_route_unproven");
    expect(route).toContain('redirect: "manual"');
    expect(route).toContain("AbortSignal.timeout(5_000)");
    expect(route).toContain("resolvedTogether: true");
    expect(route).toContain("notificationsSent: result.linked.length");
    expect(route).toContain("affectedAccountsNotified: accountIds.length");
    expect(route).toContain("readDefectImpact");
    expect(admin).toContain("support_resolution_proof_required");
  });

  it("allows only same-process route paths for automatic defect proof", async () => {
    const { safeInternalProbePath } = await import("../routes/support-operations");
    expect(safeInternalProbePath("/api/healthz?full=1")).toBe("/api/healthz?full=1");
    expect(safeInternalProbePath("https://example.com/healthz")).toBeNull();
    expect(safeInternalProbePath("//example.com/healthz")).toBeNull();
    expect(safeInternalProbePath("/api/healthz#unobserved")).toBeNull();
  });

  it("uses one real-identity presence mechanism and removes ghosts", () => {
    const server = source("./multiplayer.ts");
    const panel = source("../../../mustaflow/src/pages/projects/components/project-presence.tsx");
    expect(server).toContain("getSharedAccountProfile");
    expect(server).toContain("identity?.displayName || !identity.imageUrl");
    expect(server).toContain("ws.terminate()");
    expect(server).toContain("findLiveSupportGrant");
    expect(server).toContain("/^Support ticket #\\d{1,10}$/u");
    expect(server).toContain("`Support ticket #${supportGrant.ticketId}`");
    expect(server.match(/support_presence_read_only/g)).toHaveLength(2);
    expect(server).not.toMatch(/function publicPeer[\s\S]{0,300}userId:/);
    expect(panel).toContain("Revoke ${peer.name}'s support access");
    expect(panel).toContain("peer.imageUrl");
    const client = source("../../../mustaflow/src/hooks/use-multiplayer-presence.ts");
    expect(client).toContain("setPeers([])");
    expect(client).toContain("setSelf(null)");
    expect(client).toContain("Math.min(10_000");
    expect(client).toContain("window.setTimeout(connect, delay)");
  });

  it("keeps a complete named grant receipt readable by the project owner", () => {
    const access = source("../routes/support-access.ts");
    const operations = source("../routes/support-operations.ts");
    const owner = source("../../../mustaflow/src/pages/support-owner-actions.tsx");
    expect(access).toContain("staffDisplayName: requestedIdentity.displayName");
    expect(access).toContain("staffImageUrl: requestedIdentity.imageUrl");
    expect(operations).toContain("readGrantEvents(ticketId)");
    expect(owner).toContain("Full support access receipt #");
    expect(owner).toContain("event.actorDisplayName");
    expect(owner).toContain("receiptDetailLines(event)");
    expect(owner).toContain('["versionId", "Project version"]');
  });
});
