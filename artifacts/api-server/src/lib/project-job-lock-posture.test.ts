import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

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
});
