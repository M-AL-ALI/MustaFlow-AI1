import { readFileSync } from "node:fs";
import ts from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";

process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY ?? Buffer.alloc(32, 11).toString("base64");
process.env.DATABASE_URL = process.env.DATABASE_URL ?? "postgres://test:test@127.0.0.1:1/test";

afterEach(() => {
  vi.unstubAllGlobals();
});

function source(relative: string): string {
  return readFileSync(new URL(relative, import.meta.url), "utf8");
}

function inspectConsentBeforeProjectWrites(text: string) {
  const file = ts.createSourceFile("jobs.ts", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const runJob = file.statements.find(
    (node): node is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(node) && node.name?.text === "runJob",
  );
  if (!runJob?.body) throw new Error("Missing runJob body");
  const writes: ts.CallExpression[] = [];
  const guards: ts.CallExpression[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      if (node.expression.text === "writeProjectFilesAtomically") writes.push(node);
      if (node.expression.text === "assertSupportGrantStillAuthorizesMutation") guards.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(runJob.body);
  if (writes.length === 0) throw new Error("No project-file writes found");
  for (const write of writes) {
    const awaited = write.parent;
    if (!ts.isAwaitExpression(awaited)) throw new Error("Project-file write is not awaited");
    let statement: ts.Statement | undefined;
    if (ts.isExpressionStatement(awaited.parent)) {
      statement = awaited.parent;
    } else if (
      ts.isVariableDeclaration(awaited.parent) &&
      awaited.parent.initializer === awaited &&
      ts.isVariableDeclarationList(awaited.parent.parent) &&
      awaited.parent.parent.declarations.length === 1 &&
      (awaited.parent.parent.flags & ts.NodeFlags.Const) !== 0 &&
      ts.isVariableStatement(awaited.parent.parent.parent)
    ) {
      statement = awaited.parent.parent.parent;
    }
    if (!statement || !ts.isBlock(statement.parent)) {
      throw new Error("Project-file write must be a standalone awaited statement or const receipt");
    }
    const previous =
      statement.parent.statements[statement.parent.statements.indexOf(statement) - 1];
    if (
      !previous ||
      !ts.isExpressionStatement(previous) ||
      !ts.isAwaitExpression(previous.expression) ||
      !ts.isCallExpression(previous.expression.expression) ||
      !ts.isIdentifier(previous.expression.expression.expression) ||
      previous.expression.expression.expression.text !==
        "assertSupportGrantStillAuthorizesMutation" ||
      previous.expression.expression.arguments.length !== 0
    ) {
      throw new Error("Project-file write lacks its immediately preceding awaited consent check");
    }
  }
  if (guards.length !== writes.length + 1) {
    throw new Error("Expected one entry consent check plus one check for every write");
  }
  return { writes, guards };
}

describe("consented support operations", () => {
  it("ends a support session at an expired, revoked, declined or closed grant", async () => {
    const { effectiveSupportGrantStatus, presentSupportGrants } = await import("./support-access");
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
    expect(
      presentSupportGrants(
        [
          {
            id: 7,
            ticketId: 7,
            projectId: 52,
            ownerUserId: "owner",
            staffUserId: "staff",
            requestedBy: "staff",
            status: "active",
            reason: "Acceptance proof",
            requestedAt: new Date("2026-08-27T10:00:00.000Z"),
            decidedAt: new Date("2026-08-27T10:01:00.000Z"),
            expiresAt: new Date("2026-08-27T11:00:00.000Z"),
            revokedAt: null,
            closedAt: null,
          },
        ],
        now,
      )[0]?.status,
    ).toBe("expired");
  });

  it("presents clock-expired grants truthfully on both support operation reads", () => {
    const route = source("../routes/support-operations.ts");
    expect(route.match(/grants: presentSupportGrants\(grants\)/g)).toHaveLength(2);
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
    expect(first.join("\n")).toContain(
      "ADD COLUMN IF NOT EXISTS priority TEXT NOT NULL DEFAULT 'normal'",
    );
    expect(first.join("\n")).toContain("ADD COLUMN IF NOT EXISTS assigned_to_user_id TEXT");
    expect(first.join("\n")).toContain("ADD COLUMN IF NOT EXISTS resolved_by_user_id TEXT");
    expect(first.join("\n")).toContain("ADD COLUMN IF NOT EXISTS resolved_by_role TEXT");
    expect(first.join("\n")).toContain("ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ");
    expect(first.join("\n")).toContain("support_tickets_priority_check");
    expect(first.join("\n")).toContain("SET status = 'blocked_on_third_party'");
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
    expect(messages).toContain(
      "provenanceActorUserId: supportMutation?.staffUserId ?? req.userId!",
    );
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
    const actorAssignments = jobs.match(/actorUserId: [^,\r\n]+/g) ?? [];
    expect(actorAssignments.length).toBeGreaterThan(0);
    expect(
      actorAssignments.every(
        (assignment) =>
          assignment === "actorUserId: provenanceActorUserId" ||
          // A missing retry actor is rejected, never promoted to a support operator.
          assignment === 'actorUserId: provenanceActorUserId ?? ""' ||
          assignment === "actorUserId: session.staffUserId" ||
          assignment === "actorUserId: task.provenanceActorUserId ?? project.ownerId",
      ),
    ).toBe(true);
    expect(jobs).toContain("needsFix && !isArchitectAutoFix && !input.supportSessionId");
    expect(jobs).toContain("hasMomentNotice && !input.supportSessionId");
    expect(jobs).toContain("!isAutoFixTask &&\n                !input.supportSessionId");
    const { writes, guards } = inspectConsentBeforeProjectWrites(jobs);
    expect(writes).toHaveLength(4);
    expect(guards).toHaveLength(writes.length + 1);
    expect(jobs).toContain('event: applied ? "zero_change_applied" : "zero_change_interrupted"');
  });

  it.each([
    "await writeProjectFilesAtomically({});",
    "const receipt = await writeProjectFilesAtomically({});",
  ])("accepts adjacent consent with a bare write or an acknowledged receipt: %s", (write) => {
    const inspected = inspectConsentBeforeProjectWrites(`export async function runJob() {
      await assertSupportGrantStillAuthorizesMutation();
      await assertSupportGrantStillAuthorizesMutation();
      ${write}
    }`);
    expect(inspected.writes).toHaveLength(1);
    expect(inspected.guards).toHaveLength(2);
  });

  it.each([
    [
      "missing entry check",
      "await assertSupportGrantStillAuthorizesMutation(); await writeProjectFilesAtomically({});",
    ],
    [
      "missing adjacent check",
      "await assertSupportGrantStillAuthorizesMutation(); await otherWork(); await writeProjectFilesAtomically({});",
    ],
    [
      "unawaited consent",
      "await assertSupportGrantStillAuthorizesMutation(); assertSupportGrantStillAuthorizesMutation(); await writeProjectFilesAtomically({});",
    ],
    [
      "intervening mutation",
      "await assertSupportGrantStillAuthorizesMutation(); await assertSupportGrantStillAuthorizesMutation(); await otherWork(); await writeProjectFilesAtomically({});",
    ],
    [
      "different statement block",
      "await assertSupportGrantStillAuthorizesMutation(); { await assertSupportGrantStillAuthorizesMutation(); } await writeProjectFilesAtomically({});",
    ],
    [
      "conditional consent",
      "await assertSupportGrantStillAuthorizesMutation(); if (allowed) { await assertSupportGrantStillAuthorizesMutation(); } await writeProjectFilesAtomically({});",
    ],
    [
      "unawaited write",
      "await assertSupportGrantStillAuthorizesMutation(); await assertSupportGrantStillAuthorizesMutation(); writeProjectFilesAtomically({});",
    ],
    [
      "additional initializer",
      "await assertSupportGrantStillAuthorizesMutation(); await assertSupportGrantStillAuthorizesMutation(); const receipt = await writeProjectFilesAtomically({}), other = otherWork();",
    ],
  ])("rejects a consent contract with %s", (_label, body) => {
    expect(() =>
      inspectConsentBeforeProjectWrites(`export async function runJob() { ${body} }`),
    ).toThrow();
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
    expect(admin).toContain('router.use("/admin/support-assignees", requireAdmin)');
    expect(route.match(/resolvedByUserId: req\.userId!/g)?.length).toBeGreaterThanOrEqual(2);
    expect(
      route.match(/resolvedByRole: req\.staffPrincipal!\.role/g)?.length,
    ).toBeGreaterThanOrEqual(2);
  });

  it("allows only trusted same-origin route paths for automatic defect proof", async () => {
    const {
      proveCurrentNabuFlowRoute,
      safeInternalProbePath,
      safeInternalRedirectPath,
      trustedSupportProofOrigin,
    } = await import("../routes/support-operations");
    expect(safeInternalProbePath("/api/healthz?full=1")).toBe("/api/healthz?full=1");
    expect(safeInternalProbePath("https://example.com/healthz")).toBeNull();
    expect(safeInternalProbePath("//example.com/healthz")).toBeNull();
    expect(safeInternalProbePath("/api/healthz#unobserved")).toBeNull();
    expect(safeInternalRedirectPath("/help", "/help/")).toBe("/help/");
    expect(safeInternalRedirectPath("/help", "https://example.com/help")).toBeNull();
    expect(safeInternalRedirectPath("/help", "//example.com/help")).toBeNull();

    const previousNodeEnv = process.env.NODE_ENV;
    const previousDomains = process.env.REPLIT_DOMAINS;
    process.env.NODE_ENV = "production";
    process.env.REPLIT_DOMAINS = "www.mustaflow.com";
    const request = {
      protocol: "http",
      get: (name: string) => {
        if (name.toLowerCase() === "host") return "www.mustaflow.com";
        if (name.toLowerCase() === "x-forwarded-proto") return "https";
        return undefined;
      },
    } as never;
    try {
      expect(trustedSupportProofOrigin(request)).toBe("https://www.mustaflow.com");
      const calls: string[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: unknown) => {
          calls.push(String(input));
          return calls.length === 1
            ? new Response(null, { status: 301, headers: { location: "/help/" } })
            : new Response("ok", { status: 200 });
        }),
      );
      await expect(proveCurrentNabuFlowRoute(request, "/help")).resolves.toMatchObject({
        route: "/help/",
        status: 200,
      });
      expect(calls).toEqual(["https://www.mustaflow.com/help", "https://www.mustaflow.com/help/"]);
      const untrustedRequest = {
        protocol: "http",
        get: (name: string) => (name.toLowerCase() === "host" ? "example.com" : undefined),
      } as never;
      expect(trustedSupportProofOrigin(untrustedRequest)).toBeNull();
    } finally {
      if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousNodeEnv;
      if (previousDomains === undefined) delete process.env.REPLIT_DOMAINS;
      else process.env.REPLIT_DOMAINS = previousDomains;
    }
  });

  it("uses one real-identity presence mechanism and removes ghosts", () => {
    const server = source("./multiplayer.ts");
    const panel = source("../../../mustaflow/src/pages/projects/components/project-presence.tsx");
    expect(server).toContain("getSharedAccountProfile");
    expect(server).toContain("identity?.displayName || !identity.imageUrl");
    expect(server).toContain("ws.terminate()");
    expect(server).toContain("findLiveSupportGrant");
    expect(server).toContain("/^Support ticket NF-\\d{6,}$/u");
    expect(server).toContain(
      "`Support ticket ${formatSupportTicketNumber(supportGrant.ticketId)}`",
    );
    expect(server.match(/support_presence_read_only/g)).toHaveLength(2);
    expect(server).not.toMatch(/function publicPeer[\s\S]{0,300}userId:/);
    expect(panel).toContain("Revoke ${peer.name}'s support access");
    expect(panel).toContain("peer.imageUrl");
    const client = source("../../../mustaflow/src/hooks/use-multiplayer-presence.ts");
    expect(client).toContain("setPeers([])");
    expect(client).toContain("setSelf(null)");
    expect(client).toContain("Math.min(10_000");
    expect(client).toMatch(
      /window\.setTimeout\(\(\) => \{\s*reconnectTimer = null;\s*connect\(\);\s*\}, delay\)/,
    );
    expect(client).toContain("reconnectAttempt > MULTIPLAYER_MAX_RECONNECT_ATTEMPTS");
  });

  it("keeps a complete named grant receipt readable by the project owner", () => {
    const access = source("../routes/support-access.ts");
    const operations = source("../routes/support-operations.ts");
    const owner = source("../../../mustaflow/src/pages/support-owner-actions.tsx");
    expect(access).toContain("const staffDisplayName = requestedIdentity.displayName");
    expect(access).toContain("const staffImageUrl = requestedIdentity.imageUrl");
    expect(access).toContain("staffDisplayName,");
    expect(access).toContain("staffImageUrl,");
    expect(operations).toContain("readGrantEvents(ticketId)");
    expect(owner).toContain("Full support access receipt #");
    expect(owner).toContain("event.actorDisplayName");
    expect(owner).toContain("receiptDetailLines(event)");
    expect(owner).toContain('["versionId", "Project version"]');
  });
});
