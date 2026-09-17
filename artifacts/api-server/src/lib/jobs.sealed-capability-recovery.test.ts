import { readFileSync } from "node:fs";
import { Script } from "node:vm";
import * as ts from "typescript";
import { describe, expect, it } from "vitest";
import type { TaskReport } from "@workspace/db";
import { ZeroCapabilityGapError } from "./zero-capability-eligibility";
import { ZeroSealedSourceContractError } from "./zero-sealed-generation";
import {
  FailedDraftRecoveryError,
  describeFailedDraft,
  failedDraftFingerprint,
  resolveFailedRetry,
} from "./zero-sealed-failed-draft";

// Execute the production catch-path projection without starting the job queue.
const source = readFileSync(new URL("./jobs.ts", import.meta.url), "utf8");
const parsed = ts.createSourceFile("jobs.ts", source, ts.ScriptTarget.Latest, true);
const evidenceNodes: ts.VariableStatement[] = [];
const captureNodes: ts.IfStatement[] = [];
function visit(node: ts.Node): void {
  if (
    ts.isVariableStatement(node) &&
    node.declarationList.declarations.some(
      (declaration) => declaration.name.getText(parsed) === "failureEvidence",
    )
  ) {
    evidenceNodes.push(node);
  }
  if (
    ts.isIfStatement(node) &&
    node.expression.getText(parsed).includes("sealedFailureFiles?.length")
  ) {
    captureNodes.push(node);
  }
  ts.forEachChild(node, visit);
}
visit(parsed);
if (evidenceNodes.length !== 1 || captureNodes.length !== 1) {
  throw new Error("Expected one production failed-draft evidence and capture path");
}
const compiled = ts.transpileModule(
  `(function (context, dependencies) {
    const {
      err, interruptedMutationCommitted, sealedFailureFiles,
      interruptedPreRunFiles, provenanceActorUserId
    } = context;
    const {
      FailedDraftRecoveryError, ZeroCapabilityGapError,
      ZeroSealedSourceContractError, describeFailedDraft
    } = dependencies;
    class ZeroGenerationKitchenError extends Error {}
    const modelRequestFailure = undefined;
    const ZERO_SEALED_SOURCE_REPAIR_MESSAGE = "Source repair required";
    const logger = { warn() {} };
    const taskId = 341;
    const projectId = 61;
    ${evidenceNodes[0].getText(parsed)}
    let draft;
    ${captureNodes[0].getText(parsed)}
    return { failureEvidence, draft };
  })`,
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } },
);
const productionCapture = new Script(compiled.outputText).runInNewContext(
  {},
  { timeout: 1000 },
) as (
  context: Record<string, unknown>,
  dependencies: Record<string, unknown>,
) => {
  failureEvidence?: TaskReport["failureEvidence"];
  draft?: TaskReport["sealedFailedDraft"];
};

const base = [{ path: "src/routes/notes.ts", content: "original", mimeType: "text/typescript" }];
const candidate = [{ ...base[0], content: 'void fetch("https://example.test/not-allowed");' }];
const capabilityError = () =>
  new ZeroCapabilityGapError({
    ok: false,
    code: "zero_capability_gap",
    retryable: false,
    identitySha256: "a".repeat(64),
    reasons: [{ code: "arbitrary_runtime_fetch", path: "src/routes/notes.ts" }],
  });
function capture(overrides: Record<string, unknown> = {}) {
  return productionCapture(
    {
      err: capabilityError(),
      interruptedMutationCommitted: false,
      sealedFailureFiles: candidate,
      interruptedPreRunFiles: base,
      provenanceActorUserId: "owner",
      ...overrides,
    },
    {
      FailedDraftRecoveryError,
      ZeroCapabilityGapError,
      ZeroSealedSourceContractError,
      describeFailedDraft,
    },
  );
}

describe("sealed capability failure draft recovery", () => {
  it("retains the rejected candidate and its typed evidence without applying it", () => {
    const before = JSON.stringify(base);
    const result = capture();
    expect(result.failureEvidence).toMatchObject({
      code: "zero_capability_gap",
      evidence: {
        stage: "capability-eligibility",
        identitySha256: "a".repeat(64),
        reasons: [{ code: "arbitrary_runtime_fetch", path: "src/routes/notes.ts" }],
      },
    });
    expect(result.draft).toEqual({
      schema: 1,
      actorUserId: "owner",
      baseFingerprint: failedDraftFingerprint(base),
      candidateFingerprint: failedDraftFingerprint(candidate),
      fileCount: 1,
    });
    expect(JSON.stringify(base)).toBe(before);
    expect(JSON.stringify(result)).not.toContain("https://example.test/not-allowed");
  });

  it("preserves source-contract recovery", () => {
    const result = capture({
      err: new ZeroSealedSourceContractError(["health_route"], "src/index.ts"),
    });
    expect(result.failureEvidence?.code).toBe("zero_sealed_source_contract_error");
    expect(result.draft?.candidateFingerprint).toBe(failedDraftFingerprint(candidate));
  });

  it.each([
    { interruptedMutationCommitted: true },
    { sealedFailureFiles: null },
    { sealedFailureFiles: [] },
    { interruptedPreRunFiles: null },
    { provenanceActorUserId: null },
    { provenanceActorUserId: "" },
  ])("does not retain a draft when a capture prerequisite is absent: %j", (override) => {
    expect(capture(override).draft).toBeUndefined();
  });

  it("does not classify an arbitrary error by its name or code alone", () => {
    const impostor = Object.assign(new Error("Not a classified failure"), {
      name: "ZeroCapabilityGapError",
      code: "zero_capability_gap",
    });
    expect(capture({ err: impostor })).toEqual({ failureEvidence: undefined, draft: undefined });
  });

  it("rejects a malformed candidate without claiming it was saved", () => {
    expect(
      capture({ sealedFailureFiles: [{ ...candidate[0], path: "../secret" }] }).draft,
    ).toBeUndefined();
  });

  it("requires the same owner and unchanged base to recover the saved candidate", () => {
    const result = capture();
    const request = "Keep English and Arabic and the current note when switching language.";
    const input = {
      source: {
        id: 341,
        projectId: 61,
        status: "failed",
        prompt: request,
        provenanceActorUserId: "owner",
        report: {
          userRequest: request,
          filesCreated: [],
          filesChanged: [],
          filesRemoved: [],
          previewUpdated: false,
          warnings: [],
          integrationsNeeded: [],
          failureEvidence: result.failureEvidence,
          sealedFailedDraft: result.draft,
        },
        stagingSnapshot: candidate,
      },
      projectId: 61,
      actorUserId: "owner",
      ownerUserId: "owner",
      currentFiles: base,
      submittedContent: request,
    };
    expect(resolveFailedRetry(input).files).toEqual(candidate);
    expect(resolveFailedRetry(input).content).toBe(request);
    expect(() => resolveFailedRetry({ ...input, actorUserId: "collaborator" })).toThrow(
      FailedDraftRecoveryError,
    );
    expect(() => resolveFailedRetry({ ...input, currentFiles: candidate })).toThrow(
      FailedDraftRecoveryError,
    );
    expect(input.source.report.previewUpdated).toBe(false);
    expect(input.source.report.filesChanged).toEqual([]);
  });
});
