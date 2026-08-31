import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const jobsSource = readFileSync(new URL("./jobs.ts", import.meta.url), "utf8");

function sliceFunction(startMarker: string, nextMarker: string): string {
  const start = jobsSource.indexOf(startMarker);
  const end = jobsSource.indexOf(nextMarker, start + startMarker.length);
  expect(start, `${startMarker} must exist`).toBeGreaterThanOrEqual(0);
  expect(end, `${nextMarker} must follow ${startMarker}`).toBeGreaterThan(start);
  return jobsSource.slice(start, end);
}

describe("project retirement job boundaries", () => {
  it("denies a deleted project before runJob performs intent admission or provider work", () => {
    const runJob = sliceFunction(
      "export async function runJob(input: JobInput)",
      "// ─────────────────────────────────────────────────────────────────────────────\n// Legacy staged review",
    );
    const guard = runJob.indexOf("await readProjectJobAdmission(projectId)");
    const intentAdmission = runJob.indexOf("await governIntentAdmission");

    expect(guard).toBeGreaterThanOrEqual(0);
    expect(intentAdmission).toBeGreaterThan(guard);
    expect(runJob.slice(guard, intentAdmission)).toContain("return;");
  });

  it("rechecks the tombstone after the cross-replica project lock and before task claim", () => {
    const claim = sliceFunction(
      "export async function claimProjectJobExecution",
      "export async function runJob(input: JobInput)",
    );
    const lock = claim.indexOf(
      "pg_advisory_xact_lock(${PROJECT_JOB_LOCK_NAMESPACE}, ${projectId})",
    );
    const activeRecheck = claim.indexOf("const [activeProject]", lock);
    const transition = claim.indexOf("const transitioned", activeRecheck);

    expect(lock).toBeGreaterThanOrEqual(0);
    expect(activeRecheck).toBeGreaterThan(lock);
    expect(transition).toBeGreaterThan(activeRecheck);
    expect(claim.slice(activeRecheck, transition)).toContain("isNull(projectsTable.deletedAt)");
  });

  it("prevents both project and batch drains from selecting a deleted project", () => {
    const batchDrain = sliceFunction(
      "async function drainNextBatchTask",
      "/**\n * Load object-storage URLs",
    );
    const projectDrain = sliceFunction(
      "export async function drainNextProjectTask",
      "/**\n * Task #638",
    );

    expect(batchDrain).toContain("isNull(projectsTable.deletedAt)");
    expect(projectDrain).toContain("await readProjectJobAdmission(projectId)");
    expect(projectDrain).toContain("isNull(projectsTable.deletedAt)");
  });

  it("binds local controllers to projects so retirement can abort and evict local work", () => {
    expect(jobsSource).toContain("activeJobProjects.set(taskId, projectId)");
    expect(jobsSource).toContain("activeJobProjects.delete(taskId)");
    expect(jobsSource).toContain("_pendingJobs.splice(index, 1)");
  });

  it("aborts a cross-replica running job when its heartbeat observes the tombstone", () => {
    const runJob = sliceFunction(
      "export async function runJob(input: JobInput)",
      "// ─────────────────────────────────────────────────────────────────────────────\n// Legacy staged review",
    );
    const heartbeat = runJob.indexOf("const writeJobHeartbeat");
    const lifecycle = runJob.indexOf("await readProjectJobAdmission(projectId)", heartbeat);
    const abort = runJob.indexOf("abortController.abort()", lifecycle);
    const heartbeatWrite = runJob.indexOf("lastHeartbeatAt: new Date()", lifecycle);

    expect(heartbeat).toBeGreaterThanOrEqual(0);
    expect(lifecycle).toBeGreaterThan(heartbeat);
    expect(abort).toBeGreaterThan(lifecycle);
    expect(heartbeatWrite).toBeGreaterThan(abort);
  });
});
