import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function source(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

const creatorFiles = [
  { path: "../routes/messages.ts", creators: 4, jobAdmissions: 2 },
  // Block ZZZZ declares the snapshot-observe handler as a non-mutation creator.
  { path: "../routes/snapshot-observe.ts", creators: 1 },
  { path: "../routes/blueprints.ts", creators: 1, executions: 1 },
  { path: "../routes/domains.ts", creators: 1, jobAdmissions: 1 },
  { path: "../routes/mobile-settings.ts", creators: 1, executions: 1 },
  { path: "../routes/projects.ts", creators: 1, jobAdmissions: 1 },
  { path: "../routes/queue.ts", creators: 1, jobAdmissions: 1 },
  { path: "../routes/suggestions.ts", creators: 1, jobAdmissions: 1 },
  { path: "../routes/tasks.ts", creators: 1, jobAdmissions: 1 },
  { path: "../routes/versions.ts", creators: 1, executions: 1 },
  { path: "../routes/v1/builds.ts", creators: 1, jobAdmissions: 1 },
  { path: "./deployment-scheduler.ts", creators: 1, jobAdmissions: 1 },
] as const;

describe("zero intent creator census", () => {
  it("routes every enumerated task creator through the one admission governor", () => {
    for (const file of creatorFiles) {
      const body = source(file.path);
      expect(body.match(/phase: "creator"/gu) ?? [], file.path).toHaveLength(file.creators);
      expect(body, file.path).toContain("governIntentAdmission");
    }
  });

  it("carries the admitted receipt into every queued or direct mutation execution", () => {
    for (const file of creatorFiles) {
      const body = source(file.path);
      if ("jobAdmissions" in file) {
        expect(body.match(/intentReceiptId: admission\.receiptId/gu) ?? [], file.path).toHaveLength(
          file.jobAdmissions,
        );
      }
      if ("executions" in file) {
        expect(body.match(/phase: "execution"/gu) ?? [], file.path).toHaveLength(file.executions);
      }
    }
  });

  it("keeps answer, clarify, plan, and observe on non-mutation task branches", () => {
    const messages = source("../routes/messages.ts");
    expect(messages).toMatch(
      /resolvedIntent === "answer"\s*\|\|\s*resolvedIntent === "clarify"\s*\|\|\s*resolvedIntent === "observe"/u,
    );
    expect(messages).toContain('resolvedIntent === "plan"');
    expect(messages.match(/mutationCapable: false/gu)).toHaveLength(3);
    expect(messages.match(/mutationCapable: true/gu)).toHaveLength(1);
  });

  it("admits at runJob and retirement, preserving receipts through serialization and drains", () => {
    const jobs = source("./jobs.ts");
    expect(jobs.match(/phase: "creator"/gu)).toHaveLength(4);
    expect(jobs.match(/intentReceiptId: admission\.receiptId/gu)).toHaveLength(3);
    expect(jobs).toContain("project-retirement:${projectId}:task:${task.id}");
    expect(jobs).toContain('phase: "execution"');
    expect(jobs).toContain("persistIntentReceiptAdmissionRejected(taskId, code)");
    expect(jobs).toContain("Intent receipt admission rejected task");
    expect(jobs).toContain("intentReceiptId: input.intentReceiptId ?? null");
    expect(jobs.match(/intentReceiptId: nextTask\.intentReceiptId/gu)).toHaveLength(2);
  });
});
