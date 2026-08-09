import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const EVIDENCE_RUN_ID_PATTERN = /^[0-9]{8}T[0-9]{6}[0-9]{3}Z-[A-Za-z0-9_-]{8,128}$/u;

export function createStagingEvidenceRunId(now: Date, entropy: string): string {
  const timestamp = now.toISOString().replace(/[-:.]/gu, "");
  const normalizedEntropy = entropy.replaceAll("-", "");
  const runId = `${timestamp}-${normalizedEntropy}`;
  if (!EVIDENCE_RUN_ID_PATTERN.test(runId)) throw new Error("Evidence run identifier is invalid");
  return runId;
}

export function writeImmutableStagingEvidence(input: {
  directory: string;
  runId: string;
  phase: "pre-cleanup" | "final";
  transcript: unknown;
  generatedAt?: Date;
}): string {
  if (!EVIDENCE_RUN_ID_PATTERN.test(input.runId))
    throw new Error("Evidence run identifier is invalid");
  mkdirSync(input.directory, { recursive: true });
  const evidencePath = resolve(
    input.directory,
    `staging-acceptance-${input.runId}-${input.phase}.json`,
  );
  writeFileSync(
    evidencePath,
    `${JSON.stringify(
      {
        runId: input.runId,
        generatedAt: (input.generatedAt ?? new Date()).toISOString(),
        phase: input.phase,
        transcript: input.transcript,
      },
      null,
      2,
    )}\n`,
    { encoding: "utf8", flag: "wx" },
  );
  return evidencePath;
}
