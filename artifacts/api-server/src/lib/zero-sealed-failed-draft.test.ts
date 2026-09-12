import { describe, expect, it } from "vitest";
import {
  describeFailedDraft,
  failedDraftFingerprint,
  mergeFailedDraftFiles,
  resolveFailedRetry,
  FailedDraftRecoveryError,
  type FailedRetryTask,
} from "./zero-sealed-failed-draft";
const file = (path: string, content = path) => ({ path, content, mimeType: "text/plain" });
const base = [file("src/main.ts", "original")];
const candidate = [file("src/main.ts", "draft"), file("src/index.ts", "new server")];
const original = (
  "Build an English and Arabic notebook with durable note storage. " +
  "Keep the complete requirements. ".repeat(12)
).trim();
function source(): FailedRetryTask {
  return {
    id: 320,
    projectId: 61,
    status: "failed",
    prompt: original,
    provenanceActorUserId: "owner",
    report: {
      userRequest: original,
      filesCreated: [],
      filesChanged: [],
      filesRemoved: [],
      previewUpdated: false,
      warnings: [],
      integrationsNeeded: [],
      sealedFailedDraft: describeFailedDraft({ files: candidate, base, actorUserId: "owner" }),
    },
    stagingSnapshot: candidate,
  };
}
const input = () => ({
  source: source(),
  projectId: 61,
  actorUserId: "owner",
  ownerUserId: "owner",
  currentFiles: base,
  submittedContent: original,
});
describe("inert sealed-source draft recovery", () => {
  it("retains the complete candidate without mutating the working base", () => {
    const before = JSON.stringify(base);
    const recovered = resolveFailedRetry(input());
    expect(recovered.files).toEqual(candidate);
    expect(recovered.content).toBe(original);
    expect(recovered.binding).toEqual({
      taskId: 320,
      actorUserId: "owner",
      baseFingerprint: failedDraftFingerprint(base),
    });
    expect(JSON.stringify(base)).toBe(before);
    expect(recovered.files).not.toBe(candidate);
  });
  it("normalizes only surrounding prompt whitespace", () => {
    const parent = source();
    parent.prompt = "  " + original + "\n";
    expect(
      resolveFailedRetry({ ...input(), source: parent, submittedContent: "  " + original + "  " })
        .content,
    ).toBe(original);
  });
  it("retains full requirements and additional retry instructions", () => {
    expect(
      resolveFailedRetry({
        ...input(),
        submittedContent: "Repair the source checks without removing Arabic.",
      }).content,
    ).toBe(
      original +
        "\n\nAdditional instructions for this retry:\nRepair the source checks without removing Arabic.",
    );
    expect(
      resolveFailedRetry({ ...input(), submittedContent: original + " Also keep mobile layout." })
        .content,
    ).toBe(original + " Also keep mobile layout.");
  });
  it("fails closed on changed base, even if a path was added rather than edited", () => {
    expect(() =>
      resolveFailedRetry({ ...input(), currentFiles: [file("src/main.ts", "manual edit")] }),
    ).toThrow(FailedDraftRecoveryError);
    expect(() =>
      resolveFailedRetry({ ...input(), currentFiles: [...base, file("new.ts")] }),
    ).toThrow(FailedDraftRecoveryError);
  });
  it.each(["completed", "canceled", "cancelled", "building", "needs_review", "needs_fix"])(
    "cannot retry a %s source",
    (status) => {
      expect(() => resolveFailedRetry({ ...input(), source: { ...source(), status } })).toThrow(
        FailedDraftRecoveryError,
      );
    },
  );
  it("rejects collaborator, hostile project id, ownership transfer, and missing source", () => {
    for (const override of [
      { actorUserId: "collaborator" },
      { projectId: 51 },
      { ownerUserId: "new-owner" },
      { source: undefined },
    ]) {
      expect(() => resolveFailedRetry({ ...input(), ...override })).toThrow(
        FailedDraftRecoveryError,
      );
    }
  });
  it("does not import Aura, support-session, or another actor's draft", () => {
    for (const override of [
      { origin: "ora" },
      { origin: "aura" },
      { supportSessionId: 1 },
      { provenanceActorUserId: "staff" },
    ]) {
      expect(() =>
        resolveFailedRetry({ ...input(), source: { ...source(), ...override } }),
      ).toThrow(FailedDraftRecoveryError);
    }
    const altered = source();
    altered.report!.sealedFailedDraft!.actorUserId = "other";
    expect(() => resolveFailedRetry({ ...input(), source: altered })).toThrow(
      FailedDraftRecoveryError,
    );
  });
  it("rejects altered, partial, and malformed saved snapshots", () => {
    for (const stagingSnapshot of [
      null,
      [],
      candidate.slice(0, 1),
      [file("../secret")],
      [file("C:/secret")],
      [file("a\\b")],
      [file("a"), file("a")],
      [file("src/main.ts", "tampered"), candidate[1]],
    ]) {
      expect(() =>
        resolveFailedRetry({ ...input(), source: { ...source(), stagingSnapshot } }),
      ).toThrow(FailedDraftRecoveryError);
    }
  });
  it("allows only the durable claimed child and rechecks its base before execution", () => {
    const parent = source();
    parent.report!.retryChildTaskId = 321;
    expect(() => resolveFailedRetry({ ...input(), source: parent })).toThrow(
      FailedDraftRecoveryError,
    );
    expect(() => resolveFailedRetry({ ...input(), source: parent, childTaskId: 322 })).toThrow(
      FailedDraftRecoveryError,
    );
    expect(resolveFailedRetry({ ...input(), source: parent, childTaskId: 321 }).files).toEqual(
      candidate,
    );
    expect(() =>
      resolveFailedRetry({
        ...input(),
        source: parent,
        childTaskId: 321,
        expectedBaseFingerprint: "changed",
      }),
    ).toThrow(FailedDraftRecoveryError);
  });
  it("uses legacy full request without claiming there is a saved draft", () => {
    const parent = source();
    delete parent.report!.sealedFailedDraft;
    parent.stagingSnapshot = null;
    parent.provenanceActorUserId = null;
    const recovered = resolveFailedRetry({ ...input(), source: parent });
    expect(recovered.files).toBeNull();
    expect(recovered.content).toBe(original);
  });
  it("does not invent a prompt from a shortened title", () => {
    const parent = source();
    parent.prompt = null;
    parent.report!.userRequest = "";
    expect(() => resolveFailedRetry({ ...input(), source: parent })).toThrow(
      /original request is unavailable/,
    );
  });
  it("fingerprints all contents independent of database ordering", () => {
    expect(failedDraftFingerprint(candidate)).toBe(
      failedDraftFingerprint([...candidate].reverse()),
    );
    expect(failedDraftFingerprint(candidate)).not.toBe(failedDraftFingerprint(base));
  });
  it("merges repairs into the whole draft, including explicit removals", () => {
    expect(
      mergeFailedDraftFiles(
        candidate,
        [file("src/index.ts", "repaired"), file("tsconfig.json", "correct")],
        ["src/main.ts"],
      ),
    ).toEqual([file("src/index.ts", "repaired"), file("tsconfig.json", "correct")]);
    expect(candidate).toEqual([file("src/main.ts", "draft"), file("src/index.ts", "new server")]);
  });
});
