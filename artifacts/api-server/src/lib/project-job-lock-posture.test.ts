import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { extractCatchClauseByParameter } from "./source-ast-test-helper";

describe("project job cross-replica lock posture", () => {
  it("uses a namespaced transaction-scoped lock and no session-scoped project lock", () => {
    const source = readFileSync(new URL("./jobs.ts", import.meta.url), "utf8");
    const namespaceMatch = source.match(/PROJECT_JOB_LOCK_NAMESPACE = (0x[0-9a-f]+)/i);

    expect(namespaceMatch?.[1]).toBe("0x4e424a42");
    expect(Number(namespaceMatch?.[1])).toBeLessThanOrEqual(0x7fffffff);
    expect(source).toContain("pg_advisory_xact_lock(${PROJECT_JOB_LOCK_NAMESPACE}, ${projectId})");
    expect(source).not.toContain("pg_advisory_lock($1::bigint)");
    expect(source).not.toContain("pg_advisory_unlock");
  });

  it("always acquires the account lock before the project lock", () => {
    const source = readFileSync(new URL("./jobs.ts", import.meta.url), "utf8");
    const accountLock =
      "pg_advisory_xact_lock(${ACCOUNT_JOB_LOCK_NAMESPACE}, ${admissionScope.lockId})";
    const projectLock = "pg_advisory_xact_lock(${PROJECT_JOB_LOCK_NAMESPACE}, ${projectId})";

    expect(source).toContain("Lock order is a correctness law: account BEFORE project");
    expect(source.indexOf(accountLock)).toBeGreaterThan(-1);
    expect(source.indexOf(projectLock)).toBeGreaterThan(source.indexOf(accountLock));
  });

  it("counts only running builds while preserving every established project blocker", () => {
    const source = readFileSync(new URL("./jobs.ts", import.meta.url), "utf8");

    expect(source).toContain('eq(agentTasksTable.status, "building")');
    expect(source).toContain('["building", "needs_review", "needs_fix"]');
    expect(source).toContain('completionKind: "admission_blocked"');
    expect(source).toContain('eventType: "failed"');
  });

  it("terminalizes admission infrastructure failure without reaching repair-model dispatch", () => {
    const source = readFileSync(new URL("./jobs.ts", import.meta.url), "utf8");
    const claimCatch = extractCatchClauseByParameter(source, "admissionError");

    expect(claimCatch).toContain("catch (admissionError)");
    expect(claimCatch).toContain("persistParallelBuildAdmissionUnavailable(taskId)");
    expect(claimCatch).toContain("return;");
    expect(claimCatch).not.toContain("generateFixSuggestions");
    expect(claimCatch).not.toContain("runBuildPipeline");
    expect(source).toContain('code: "parallel_build_admission_unavailable"');
  });
});
