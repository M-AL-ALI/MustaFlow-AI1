import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createStagingEvidenceRunId,
  writeImmutableStagingEvidence,
} from "../scripts/staging-evidence";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("staging evidence custody", () => {
  it("gives every invocation immutable filenames so cleanup cannot overwrite failed-run evidence", () => {
    const directory = mkdtempSync(join(tmpdir(), "nabuflow-staging-evidence-"));
    temporaryDirectories.push(directory);
    const failedRun = createStagingEvidenceRunId(
      new Date("2026-08-09T04:00:00.000Z"),
      "11111111-1111-4111-8111-111111111111",
    );
    const cleanupRun = createStagingEvidenceRunId(
      new Date("2026-08-09T04:01:00.000Z"),
      "22222222-2222-4222-8222-222222222222",
    );
    const failedPath = writeImmutableStagingEvidence({
      directory,
      runId: failedRun,
      phase: "pre-cleanup",
      transcript: [{ step: "failure" }],
    });
    const failedBytes = readFileSync(failedPath);
    const cleanupPath = writeImmutableStagingEvidence({
      directory,
      runId: cleanupRun,
      phase: "final",
      transcript: [{ step: "cleanup" }],
    });

    expect(cleanupPath).not.toBe(failedPath);
    expect(readFileSync(failedPath)).toEqual(failedBytes);
    expect(() =>
      writeImmutableStagingEvidence({
        directory,
        runId: failedRun,
        phase: "pre-cleanup",
        transcript: [],
      }),
    ).toThrow();
  });
});
