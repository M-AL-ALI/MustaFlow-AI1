import { readFileSync } from "node:fs";
import { Script } from "node:vm";
import * as ts from "typescript";
import { describe, expect, it } from "vitest";
import type { TaskReport } from "@workspace/db";
import { CommittedBuildFileReport } from "./committed-build-file-report";

// Exercise the actual report projection without starting the queue/worker module.
const source = readFileSync(new URL("./jobs.ts", import.meta.url), "utf8");
const parsed = ts.createSourceFile("jobs.ts", source, ts.ScriptTarget.Latest, true);
const nodes: ts.VariableStatement[] = [];
function visit(node: ts.Node): void {
  if (
    ts.isVariableStatement(node) &&
    node.declarationList.declarations.some(
      (declaration) => declaration.name.getText(parsed) === "failedReport",
    )
  )
    nodes.push(node);
  ts.forEachChild(node, visit);
}
visit(parsed);
if (nodes.length !== 1) throw new Error("Expected one production failedReport projection");
const compiled = ts.transpileModule(
  "(function (context) { const { sealedFailureReport, modelFailureReport, userPrompt, failureEvidence, retrySource, draft, committedFileReport } = context; " +
    nodes[0].getText(parsed) +
    "; return failedReport; })",
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } },
);
const projectFailure = new Script(compiled.outputText).runInNewContext({}, { timeout: 1000 }) as (
  context: Record<string, unknown>,
) => TaskReport;
const context = {
  userPrompt: "Keep the complete original app requirements.",
  retrySource: { taskId: 320, actorUserId: "owner", baseFingerprint: "base" },
};

describe("sealed failed-draft report projection", () => {
  it("prefers a later classified model failure over an earlier loop report", () => {
    const latest = {
      agentLoop: { terminationReason: "agent_model_request_timeout", toolCalls: [{ args: {} }] },
      warnings: ["Latest model failure"],
    };
    const report = projectFailure({
      ...context,
      sealedFailureReport: { agentLoop: { terminationReason: "old" }, warnings: ["old"] },
      modelFailureReport: latest,
      failureEvidence: {
        code: "agent_model_request_timeout",
        message: "Latest failure",
        evidence: null,
      },
    });
    expect(report.agentLoop).toEqual(latest.agentLoop);
    expect(report.warnings).toEqual(latest.warnings);
    expect(report.failureEvidence?.code).toBe("agent_model_request_timeout");
    expect(report.previewUpdated).toBe(false);
  });
  it("retains the source-loop history without inheriting passed validation or preview claims", () => {
    const earlier = {
      agentLoop: { terminationReason: "checks-failed" },
      syntaxValid: true,
      allChecksPassed: true,
      validationReport: { passed: true },
      previewSyncQueued: true,
      warnings: ["source check failed"],
    };
    const draft = {
      schema: 1,
      actorUserId: "owner",
      baseFingerprint: "base",
      candidateFingerprint: "candidate",
      fileCount: 9,
    };
    const report = projectFailure({ ...context, sealedFailureReport: earlier, draft });
    expect(report.agentLoop).toEqual(earlier.agentLoop);
    expect(report.syntaxValid).toBeUndefined();
    expect(report.allChecksPassed).toBeUndefined();
    expect(report.validationReport).toBeUndefined();
    expect(report.previewSyncQueued).toBeUndefined();
    expect(report.previewUpdated).toBe(false);
    expect(report.filesCreated).toEqual([]);
    expect(report.sealedFailedDraft).toEqual(draft);
    expect(report.retrySource).toEqual(context.retrySource);
    expect(report.nextRecommendation).toMatch(/has not been applied or published/);
  });
  it("does not advertise a saved draft when capture was unavailable", () => {
    const report = projectFailure(context);
    expect(report.sealedFailedDraft).toBeUndefined();
    expect(report.nextRecommendation).toBeUndefined();
    expect(report.userRequest).toBe(context.userPrompt);
  });

  it("retains acknowledged file changes after a later staging failure without claiming success", () => {
    const committed = new CommittedBuildFileReport([
      { path: "server.ts", content: "before", mimeType: "text/typescript" },
      { path: "obsolete.ts", content: "before", mimeType: "text/typescript" },
    ]);
    committed.record({
      files: [
        { path: "server.ts", content: "after", mimeType: "text/typescript" },
        { path: "notes.ts", content: "PRIVATE_SOURCE", mimeType: "text/typescript" },
      ],
      replaceAll: false,
      removedPaths: ["obsolete.ts"],
    });
    const report = projectFailure({
      ...context,
      sealedFailureReport: {
        filesCreated: ["not-saved.ts"],
        previewUpdated: true,
        syntaxValid: true,
        warnings: ["Validation incomplete"],
      },
      committedFileReport: committed.toReport(),
      failureEvidence: { code: "staging_failed", message: "Staging failed", evidence: null },
    });
    expect(report.filesCreated).toEqual(["notes.ts"]);
    expect(report.filesChanged).toEqual(["server.ts"]);
    expect(report.filesRemoved).toEqual(["obsolete.ts"]);
    expect(report.previewUpdated).toBe(false);
    expect(report.syntaxValid).toBeUndefined();
    expect(report.sealedFailedDraft).toBeUndefined();
    expect(report.warnings[0]).toBe("Validation incomplete");
    expect(report.warnings[1]).toContain("saved before this run failed");
    expect(report.warnings[1]).toContain("does not mean");
    expect(report.failureEvidence?.code).toBe("staging_failed");
    expect(JSON.stringify(report)).not.toContain("PRIVATE_SOURCE");
  });

  it("does not count model-reported edits when no database commit was acknowledged", () => {
    const report = projectFailure({
      ...context,
      modelFailureReport: {
        filesCreated: ["draft.ts"],
        filesChanged: ["server.ts"],
        filesRemoved: ["notes.ts"],
        warnings: ["Model request failed"],
      },
    });
    expect(report.filesCreated).toEqual([]);
    expect(report.filesChanged).toEqual([]);
    expect(report.filesRemoved).toEqual([]);
    expect(report.warnings).toEqual(["Model request failed"]);
    expect(report.previewUpdated).toBe(false);
  });
});
