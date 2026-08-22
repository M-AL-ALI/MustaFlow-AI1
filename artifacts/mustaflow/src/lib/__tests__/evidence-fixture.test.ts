import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EvidenceFixtureHashMismatchError, loadEvidenceFixture } from "./evidence-fixture";

const temporaryDirectories: string[] = [];

function fixturePath(contents: string): string {
  const directory = mkdtempSync(join(tmpdir(), "nabuflow-evidence-fixture-"));
  temporaryDirectories.push(directory);
  const path = join(directory, "capture.jsonl");
  writeFileSync(path, contents);
  return path;
}

function sha256(contents: string): string {
  return createHash("sha256").update(contents).digest("hex");
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("loadEvidenceFixture", () => {
  it("returns bytes when they match the committed-byte fingerprint", () => {
    const contents = '{"event":"complete"}\n';
    const path = fixturePath(contents);

    expect(loadEvidenceFixture(path, sha256(contents))).toEqual(Buffer.from(contents));
  });

  it("classifies checkout line-ending conversion separately", () => {
    const committed = '{"event":"complete"}\n';
    const path = fixturePath('{"event":"complete"}\r\n');

    expect(() => loadEvidenceFixture(path, sha256(committed))).toThrowError(
      expect.objectContaining<Partial<EvidenceFixtureHashMismatchError>>({
        code: "evidence_fixture_hash_mismatch",
        differenceClass: "line-ending-policy",
      }),
    );
  });

  it("classifies changed content separately", () => {
    const path = fixturePath('{"event":"different"}\n');

    expect(() => loadEvidenceFixture(path, sha256('{"event":"complete"}\n'))).toThrowError(
      expect.objectContaining<Partial<EvidenceFixtureHashMismatchError>>({
        code: "evidence_fixture_hash_mismatch",
        differenceClass: "content-drift",
      }),
    );
  });
});
