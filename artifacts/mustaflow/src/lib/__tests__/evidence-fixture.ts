import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export type EvidenceFixtureDifferenceClass = "line-ending-policy" | "content-drift";

export class EvidenceFixtureHashMismatchError extends Error {
  readonly code = "evidence_fixture_hash_mismatch" as const;

  constructor(
    readonly fixturePath: string,
    readonly expectedSha256: string,
    readonly actualSha256: string,
    readonly differenceClass: EvidenceFixtureDifferenceClass,
  ) {
    super(`Evidence fixture bytes changed (${differenceClass}): ${fixturePath}`);
    this.name = "EvidenceFixtureHashMismatchError";
  }
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function normalizeLineEndings(bytes: Buffer): Buffer {
  return Buffer.from(bytes.toString("utf8").replace(/\r\n?/g, "\n"), "utf8");
}

export function loadEvidenceFixture(fixturePath: string, expectedSha256: string): Buffer {
  const bytes = readFileSync(fixturePath);
  const actualSha256 = sha256(bytes);
  if (actualSha256 === expectedSha256) return bytes;

  const normalizedSha256 = sha256(normalizeLineEndings(bytes));
  throw new EvidenceFixtureHashMismatchError(
    fixturePath,
    expectedSha256,
    actualSha256,
    normalizedSha256 === expectedSha256 ? "line-ending-policy" : "content-drift",
  );
}
