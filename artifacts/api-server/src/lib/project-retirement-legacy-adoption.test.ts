import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const retirement = readFileSync(new URL("./project-retirement.ts", import.meta.url), "utf8");
const routes = readFileSync(new URL("../routes/projects.ts", import.meta.url), "utf8");

function block(source: string, startAnchor: string, endAnchor: string): string {
  const start = source.indexOf(startAnchor);
  const end = source.indexOf(endAnchor, start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe("governed legacy project retirement adoption", () => {
  it("keeps adoption exact-ID, owner-admin only, and caller-controlled", () => {
    const batch = block(
      routes,
      'router.post(\n  "/admin/projects/retirement/batch"',
      'router.get("/projects/:id"',
    );

    expect(batch).toContain("requireAdmin");
    expect(batch).toContain("requireOwner");
    expect(batch).toContain("for (const projectId of requested as number[])");
    expect(batch.match(/allowLegacyDeleted: true/g)).toHaveLength(2);
    expect(batch).toContain("enqueueProjectRetirementOperation(accepted.operationId)");
    const completed = batch.indexOf('accepted.state === "completed"');
    const enqueue = batch.indexOf("enqueueProjectRetirementOperation(accepted.operationId)");
    expect(completed).toBeGreaterThan(-1);
    expect(enqueue).toBeGreaterThan(completed);
    expect(batch.slice(completed, enqueue)).toContain("cleanupComplete: true");
    expect(batch.slice(completed, enqueue)).toContain("continue;");
    expect(batch).not.toMatch(/projectId\s*[:=]\s*51/u);
  });

  it("reuses current receipts, requires bounded terminal recovery, and creates only new lifecycle roots", () => {
    const accept = block(
      retirement,
      "export async function acceptProjectRetirement",
      "class ProjectRetirementStepError",
    );
    const lock = accept.indexOf("pg_advisory_xact_lock");
    const existingReceipt = accept.indexOf("readLatestProjectRetirementOperation", lock);
    const incompatible = accept.indexOf('receiptMode === "refuse_incompatible_active"', lock);
    const reuse = accept.indexOf('receiptMode === "reuse_completed"', existingReceipt);
    const inFlight = accept.indexOf('receiptMode === "reuse_in_flight"', reuse);
    const preflight = accept.indexOf("readProjectRetirementPreflight(tx, existing)", inFlight);
    const receiptInsert = accept.indexOf("tx.insert(projectRetirementOperationsTable)", preflight);

    expect(lock).toBeGreaterThan(-1);
    expect(existingReceipt).toBeGreaterThan(lock);
    expect(incompatible).toBeGreaterThan(existingReceipt);
    expect(reuse).toBeGreaterThan(existingReceipt);
    expect(inFlight).toBeGreaterThan(reuse);
    expect(accept.slice(reuse, preflight)).toContain("operationId: existingOperation!.id");
    expect(preflight).toBeGreaterThan(reuse);
    expect(receiptInsert).toBeGreaterThan(preflight);
    expect(accept.match(/tx\.insert\(projectRetirementOperationsTable\)/g)).toHaveLength(1);
    expect(accept).toContain("projectRetirementOperationIdForReceiptMode({");
    expect(accept).toContain("freshOperationId: crypto.randomUUID()");
    expect(accept).toContain('code: "project_retirement_receipt_upgrade_in_progress"');
    expect(accept).toContain('code: "project_retirement_reconciliation_required"');
  });

  it("keeps active retirement unchanged and refuses hazards before any durable mutation", () => {
    const accept = block(
      retirement,
      "export async function acceptProjectRetirement",
      "class ProjectRetirementStepError",
    );
    const preflight = accept.indexOf("readProjectRetirementPreflight(tx, existing)");
    const refusal = accept.indexOf('state: "refused" as const', preflight);
    const tombstone = accept.indexOf("deletedAt: sql`now()`", refusal);
    const access = accept.indexOf("retireProjectAccessSurfaces(tx", tombstone);
    const receipt = accept.indexOf("tx.insert(projectRetirementOperationsTable)", access);
    const schedules = accept.indexOf(
      "disableProjectDeploymentSchedulesStatement(project.id)",
      receipt,
    );
    const analyses = accept.indexOf(".update(assetAnalysisEventsTable)", schedules);

    expect(accept).toContain('receiptMode === "retire_active"');
    expect(refusal).toBeGreaterThan(preflight);
    expect(tombstone).toBeGreaterThan(refusal);
    expect(access).toBeGreaterThan(tombstone);
    expect(receipt).toBeGreaterThan(access);
    expect(schedules).toBeGreaterThan(receipt);
    expect(analyses).toBeGreaterThan(schedules);
  });

  it("never creates legacy retirement operations during boot resume", () => {
    const resume = block(
      retirement,
      "export async function resumeProjectRetirementOperations",
      "export async function readProjectRetirementOperation",
    );

    expect(resume).toContain("enqueueProjectRetirementOperation(operation.id)");
    expect(resume).not.toContain("projectsTable");
    expect(resume).not.toContain(".insert(");
    expect(retirement).not.toContain("adoptLegacyProjectRetirementOperations");
  });
});
