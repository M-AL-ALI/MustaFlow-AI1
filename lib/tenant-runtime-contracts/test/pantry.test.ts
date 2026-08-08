import { describe, expect, it } from "vitest";
import {
  PANTRY_BUILD_ATTESTATION_FORMAT,
  PANTRY_BUILD_INPUT_FORMAT,
  PANTRY_CLOSURE_FORMAT,
  PANTRY_ERROR_DEFAULTS,
  PANTRY_LAYER_FORMAT,
  PANTRY_REVISION_FORMAT,
  canonicalPantryJson,
  pantryBuildAttestationHash,
  pantryBuildAttestationSchema,
  pantryBuildIdSchema,
  pantryBuildInputHash,
  pantryBuildInputSchema,
  pantryDependencyClosureHash,
  pantryDependencyClosureSchema,
  pantryErrorResponseSchema,
  pantryErrorStatus,
  pantryIngredientMerkleRoot,
  pantryLayerDescriptorHash,
  pantryLayerDescriptorSchema,
  pantryPackageCoordinateSchema,
  pantryPackageIntentSchema,
  pantryPlatformSchema,
  pantryRevisionContentSchema,
  pantryRevisionIsCommittable,
  pantryRevisionRecordSchema,
  pantryRevisionRoot,
  pantryRevisionStateSchema,
  pantryRevisionTransitionIsValid,
  pantrySignedDigestSchema,
  pantrySigningInput,
  signPantryDigest,
  verifyPantryBuildAttestation,
  verifyPantryDigestSignature,
  verifyPantryRevisionRecord,
  type PantryBuildAttestation,
  type PantryDependencyClosure,
  type PantryRevisionContent,
  type PantryRevisionRecord,
} from "../src";
import {
  PANTRY_COMPATIBILITY_CLOSURE,
  PANTRY_COMPATIBILITY_EXPECTED,
  PANTRY_COMPATIBILITY_KEY,
  PANTRY_COMPATIBILITY_LAYER,
  PANTRY_COMPATIBILITY_PLATFORM,
  fixedAttestationSignature,
  fixedRevisionSignature,
  pantryCompatibilityAttestation,
  pantryCompatibilityBuildInput,
  pantryCompatibilityRevisionContent,
} from "./pantry-vector";

const publicKeys = new Map([[PANTRY_COMPATIBILITY_KEY.kid, PANTRY_COMPATIBILITY_KEY.publicKeyPem]]);

async function compatibilityRecords(): Promise<{
  revision: PantryRevisionRecord;
  attestation: PantryBuildAttestation;
}> {
  const closureSha256 = await pantryDependencyClosureHash(PANTRY_COMPATIBILITY_CLOSURE);
  const ingredientMerkleRootSha256 = await pantryIngredientMerkleRoot(PANTRY_COMPATIBILITY_CLOSURE);
  const layerDescriptorSha256 = await pantryLayerDescriptorHash(PANTRY_COMPATIBILITY_LAYER);
  const revisionContent = pantryCompatibilityRevisionContent(
    closureSha256,
    ingredientMerkleRootSha256,
  );
  const revisionRootSha256 = await pantryRevisionRoot(revisionContent);
  const buildInput = pantryCompatibilityBuildInput(closureSha256, revisionRootSha256);
  const buildInputSha256 = await pantryBuildInputHash(buildInput);
  const statement = pantryCompatibilityAttestation(
    buildInputSha256,
    closureSha256,
    revisionRootSha256,
    layerDescriptorSha256,
  );
  const statementSha256 = await pantryBuildAttestationHash(statement);
  return {
    revision: pantryRevisionRecordSchema.parse({
      content: revisionContent,
      rootSha256: revisionRootSha256,
      signature: fixedRevisionSignature(revisionRootSha256),
    }),
    attestation: pantryBuildAttestationSchema.parse({
      statement,
      statementSha256,
      signature: fixedAttestationSignature(statementSha256),
    }),
  };
}

describe("Pantry v1 deterministic contracts", () => {
  it("pins closure, Merkle, layer, revision, build-input, and attestation compatibility vectors", async () => {
    const closureSha256 = await pantryDependencyClosureHash(PANTRY_COMPATIBILITY_CLOSURE);
    const ingredientMerkleRootSha256 = await pantryIngredientMerkleRoot(
      PANTRY_COMPATIBILITY_CLOSURE,
    );
    const layerDescriptorSha256 = await pantryLayerDescriptorHash(PANTRY_COMPATIBILITY_LAYER);
    const revision = pantryCompatibilityRevisionContent(closureSha256, ingredientMerkleRootSha256);
    const revisionRootSha256 = await pantryRevisionRoot(revision);
    const buildInput = pantryCompatibilityBuildInput(closureSha256, revisionRootSha256);
    const buildInputSha256 = await pantryBuildInputHash(buildInput);
    const attestation = pantryCompatibilityAttestation(
      buildInputSha256,
      closureSha256,
      revisionRootSha256,
      layerDescriptorSha256,
    );

    expect({
      closureSha256,
      ingredientMerkleRootSha256,
      layerDescriptorSha256,
      revisionRootSha256,
      buildInputSha256,
      attestationSha256: await pantryBuildAttestationHash(attestation),
    }).toEqual({
      closureSha256: PANTRY_COMPATIBILITY_EXPECTED.closureSha256,
      ingredientMerkleRootSha256: PANTRY_COMPATIBILITY_EXPECTED.ingredientMerkleRootSha256,
      layerDescriptorSha256: PANTRY_COMPATIBILITY_EXPECTED.layerDescriptorSha256,
      revisionRootSha256: PANTRY_COMPATIBILITY_EXPECTED.revisionRootSha256,
      buildInputSha256: PANTRY_COMPATIBILITY_EXPECTED.buildInputSha256,
      attestationSha256: PANTRY_COMPATIBILITY_EXPECTED.attestationSha256,
    });
  });

  it("verifies the fixed raw-P1363 signatures and protects kid in the signing input", async () => {
    const records = await compatibilityRecords();
    expect(pantrySigningInput(records.revision.signature)).toBe(
      PANTRY_COMPATIBILITY_EXPECTED.revisionSigningInput,
    );
    expect(pantrySigningInput(records.attestation.signature)).toBe(
      PANTRY_COMPATIBILITY_EXPECTED.attestationSigningInput,
    );
    await expect(verifyPantryRevisionRecord(records.revision, publicKeys)).resolves.toEqual({
      ok: true,
    });
    await expect(
      verifyPantryBuildAttestation(records.attestation, publicKeys, PANTRY_COMPATIBILITY_PLATFORM),
    ).resolves.toEqual({ ok: true });
  });

  it("keeps trusted signers and verifiers byte-compatible with the vector contract", async () => {
    const signature = await signPantryDigest(PANTRY_COMPATIBILITY_KEY.privateKeyPem, {
      kind: "revision",
      kid: PANTRY_COMPATIBILITY_KEY.kid,
      payloadSha256: PANTRY_COMPATIBILITY_EXPECTED.revisionRootSha256,
    });
    expect(pantrySigningInput(signature)).toBe(PANTRY_COMPATIBILITY_EXPECTED.revisionSigningInput);
    expect(signature.signature).toMatch(/^[A-Za-z0-9_-]{86}$/u);
    await expect(verifyPantryDigestSignature(publicKeys, signature)).resolves.toEqual({ ok: true });
  });

  it("canonicalizes key order by UTF-8 bytes without depending on host OS", () => {
    const left = { z: 3, a: { y: true, b: [2, "é"] } };
    const right = { a: { b: [2, "é"], y: true }, z: 3 };
    const expected = '{"a":{"b":[2,"é"],"y":true},"z":3}';
    expect(canonicalPantryJson(left)).toBe(expected);
    expect(canonicalPantryJson(right)).toBe(expected);
  });

  it.each([
    ["decomposed Unicode", { value: "e\u0301" }],
    ["unpaired surrogate", { value: "\ud800" }],
    ["fraction", { value: 1.5 }],
    ["negative zero", { value: -0 }],
    ["unsafe integer", { value: Number.MAX_SAFE_INTEGER + 1 }],
    ["undefined", { value: undefined }],
    ["non-plain object", { value: new Date("2026-08-07T00:00:00.000Z") }],
  ])("rejects non-canonical %s", (_label, input) => {
    expect(() => canonicalPantryJson(input)).toThrow();
  });

  it("separates untrusted range or dist-tag intent from exact resolved coordinates", () => {
    expect(
      pantryPackageIntentSchema.parse({ ecosystem: "npm", name: "express", selector: "latest" }),
    ).toEqual({ ecosystem: "npm", name: "express", selector: "latest" });
    expect(
      pantryPackageIntentSchema.safeParse({
        ecosystem: "npm",
        name: "express",
        selector: "^5.0.0",
      }).success,
    ).toBe(true);
    expect(
      pantryPackageCoordinateSchema.safeParse({
        ecosystem: "npm",
        name: "express",
        version: "latest",
      }).success,
    ).toBe(false);
    expect(
      pantryPackageCoordinateSchema.safeParse({
        ecosystem: "npm",
        name: "express",
        version: "5.1.0-beta.1",
      }).success,
    ).toBe(true);
  });

  it.each([
    "sha512-not-base64",
    "sha256-z4PhNX7vuL3xVChQ1m2AB9Yg5AULVxXcg/SpIdNs6c5H0NE8XYhgj4/2U80sDafNvcidRI8qqM/aRwlqR5JoxA==",
    "sha512-AAAA",
  ])("rejects malformed or non-SHA512 integrity %s", (integrity) => {
    const closure = structuredClone(PANTRY_COMPATIBILITY_CLOSURE) as PantryDependencyClosure;
    closure.ingredients[0].integrity = integrity;
    expect(pantryDependencyClosureSchema.safeParse(closure).success).toBe(false);
  });

  it("rejects credentialed or non-HTTPS resolved package URLs", () => {
    for (const tarballUrl of [
      "http://registry.npmjs.org/express.tgz",
      "https://user:password@registry.npmjs.org/express.tgz",
    ]) {
      const closure = structuredClone(PANTRY_COMPATIBILITY_CLOSURE) as PantryDependencyClosure;
      closure.ingredients[0].tarballUrl = tarballUrl;
      expect(pantryDependencyClosureSchema.safeParse(closure).success).toBe(false);
    }
  });

  it("rejects duplicate, unsorted, and incomplete exact closures", () => {
    const duplicate = structuredClone(PANTRY_COMPATIBILITY_CLOSURE) as PantryDependencyClosure;
    duplicate.ingredients.splice(1, 0, structuredClone(duplicate.ingredients[0]));
    expect(pantryDependencyClosureSchema.safeParse(duplicate).success).toBe(false);

    const unsorted = structuredClone(PANTRY_COMPATIBILITY_CLOSURE) as PantryDependencyClosure;
    unsorted.ingredients.reverse();
    expect(pantryDependencyClosureSchema.safeParse(unsorted).success).toBe(false);

    const missing = structuredClone(PANTRY_COMPATIBILITY_CLOSURE) as PantryDependencyClosure;
    missing.ingredients.shift();
    expect(pantryDependencyClosureSchema.safeParse(missing).success).toBe(false);
  });

  it("rejects wrong platform tuples and unsafe layer paths", () => {
    expect(
      pantryPlatformSchema.safeParse({ ...PANTRY_COMPATIBILITY_PLATFORM, libc: "none" }).success,
    ).toBe(false);
    expect(
      pantryPlatformSchema.safeParse({
        ...PANTRY_COMPATIBILITY_PLATFORM,
        os: "darwin",
        libc: "glibc",
      }).success,
    ).toBe(false);
    for (const mountPath of ["../node_modules", "/node_modules", "C:/node_modules", "a\\b"]) {
      expect(
        pantryLayerDescriptorSchema.safeParse({
          ...PANTRY_COMPATIBILITY_LAYER,
          mountPath,
        }).success,
      ).toBe(false);
    }
  });

  it("rejects unknown schema versions and formats across every record type", async () => {
    const records = await compatibilityRecords();
    const buildInput = pantryCompatibilityBuildInput(
      PANTRY_COMPATIBILITY_EXPECTED.closureSha256,
      PANTRY_COMPATIBILITY_EXPECTED.revisionRootSha256,
    );
    const cases = [
      pantryDependencyClosureSchema.safeParse({
        ...PANTRY_COMPATIBILITY_CLOSURE,
        schemaVersion: 2,
      }),
      pantryLayerDescriptorSchema.safeParse({ ...PANTRY_COMPATIBILITY_LAYER, schemaVersion: 2 }),
      pantryRevisionContentSchema.safeParse({ ...records.revision.content, schemaVersion: 2 }),
      pantryBuildInputSchema.safeParse({ ...buildInput, schemaVersion: 2 }),
      pantryBuildAttestationSchema.safeParse({
        ...records.attestation,
        statement: { ...records.attestation.statement, format: "nabu-pantry-attestation/v2" },
      }),
      pantrySignedDigestSchema.safeParse({ ...records.revision.signature, schemaVersion: 2 }),
    ];
    expect(cases.every((result) => !result.success)).toBe(true);
  });

  it("creates a new Merkle and revision root when an ingredient is added without moving v1", async () => {
    const oldRoot = await pantryIngredientMerkleRoot(PANTRY_COMPATIBILITY_CLOSURE);
    const expanded = structuredClone(PANTRY_COMPATIBILITY_CLOSURE) as PantryDependencyClosure;
    const newIngredient = structuredClone(expanded.ingredients[1]);
    newIngredient.package = { ecosystem: "npm", name: "zod", version: "3.25.76" };
    newIngredient.registryMetadataSha256 = "0".repeat(64);
    newIngredient.tarballUrl = "https://registry.npmjs.org/zod/-/zod-3.25.76.tgz";
    newIngredient.tarballSha256 = "1".repeat(64);
    newIngredient.normalizedContentSha256 = "2".repeat(64);
    newIngredient.dependencies = [];
    expanded.ingredients.push(newIngredient);
    const expandedClosureSha256 = await pantryDependencyClosureHash(expanded);
    const expandedMerkleRoot = await pantryIngredientMerkleRoot(expanded);
    const expandedRevisionRoot = await pantryRevisionRoot(
      pantryCompatibilityRevisionContent(expandedClosureSha256, expandedMerkleRoot),
    );

    expect(oldRoot).toBe(PANTRY_COMPATIBILITY_EXPECTED.ingredientMerkleRootSha256);
    expect(expandedMerkleRoot).not.toBe(oldRoot);
    expect(expandedRevisionRoot).not.toBe(PANTRY_COMPATIBILITY_EXPECTED.revisionRootSha256);
    expect(await pantryIngredientMerkleRoot(PANTRY_COMPATIBILITY_CLOSURE)).toBe(oldRoot);
  });

  it("rejects unknown kid, altered signatures, revision content, and attestations", async () => {
    const records = await compatibilityRecords();
    const unknownKid = {
      ...records.revision,
      signature: { ...records.revision.signature, kid: "pantry-unknown-key" },
    };
    await expect(verifyPantryRevisionRecord(unknownKid, publicKeys)).resolves.toEqual({
      ok: false,
      reason: "unknown_kid",
    });

    const alteredSignature = structuredClone(records.revision);
    alteredSignature.signature.signature = `${
      alteredSignature.signature.signature.startsWith("A") ? "B" : "A"
    }${alteredSignature.signature.signature.slice(1)}`;
    await expect(verifyPantryRevisionRecord(alteredSignature, publicKeys)).resolves.toEqual({
      ok: false,
      reason: "invalid_signature",
    });

    const alteredRevision = structuredClone(records.revision);
    alteredRevision.content.createdAt = "2026-08-07T00:00:01.000Z";
    await expect(verifyPantryRevisionRecord(alteredRevision, publicKeys)).resolves.toEqual({
      ok: false,
      reason: "content_hash_mismatch",
    });

    const alteredAttestation = structuredClone(records.attestation);
    alteredAttestation.statement.outputArtifactSha256 = "0".repeat(64);
    await expect(verifyPantryBuildAttestation(alteredAttestation, publicKeys)).resolves.toEqual({
      ok: false,
      reason: "content_hash_mismatch",
    });
  });

  it("fails a valid attestation closed against a different platform tuple", async () => {
    const { attestation } = await compatibilityRecords();
    await expect(
      verifyPantryBuildAttestation(attestation, publicKeys, {
        ...PANTRY_COMPATIBILITY_PLATFORM,
        cpu: "arm64",
      }),
    ).resolves.toEqual({ ok: false, reason: "platform_mismatch" });
  });

  it("keeps immutable revision content separate from monotonic lifecycle state", () => {
    const assembling = pantryRevisionStateSchema.parse({
      schemaVersion: 1,
      revisionId: "pantry-2026-08-07.1",
      rootSha256: PANTRY_COMPATIBILITY_EXPECTED.revisionRootSha256,
      state: "assembling",
      stateRevision: 0,
      updatedAt: "2026-08-07T00:00:00.000Z",
    });
    const committed = pantryRevisionStateSchema.parse({
      ...assembling,
      state: "committed",
      stateRevision: 1,
      updatedAt: "2026-08-07T00:01:00.000Z",
    });
    expect(pantryRevisionTransitionIsValid(assembling, committed)).toBe(true);
    expect(
      pantryRevisionTransitionIsValid(committed, {
        ...committed,
        state: "assembling",
        stateRevision: 2,
      }),
    ).toBe(false);
    expect(
      pantryRevisionTransitionIsValid(committed, {
        ...committed,
        rootSha256: "0".repeat(64),
        state: "retired",
        stateRevision: 2,
      }),
    ).toBe(false);
  });

  it("refuses commitment for rejected provenance, failed scanning, or failed lifecycle scripts", () => {
    const base = pantryCompatibilityRevisionContent(
      PANTRY_COMPATIBILITY_EXPECTED.closureSha256,
      PANTRY_COMPATIBILITY_EXPECTED.ingredientMerkleRootSha256,
    );
    expect(pantryRevisionIsCommittable(base)).toBe(true);

    const rejected = structuredClone(base) as PantryRevisionContent;
    rejected.provenanceStatus = "rejected";
    expect(pantryRevisionIsCommittable(rejected)).toBe(false);

    const failedScan = structuredClone(base) as PantryRevisionContent;
    failedScan.closure.ingredients[0].scan.malwareScan = "failed";
    expect(pantryRevisionIsCommittable(failedScan)).toBe(false);

    const failedLifecycle = structuredClone(base) as PantryRevisionContent;
    failedLifecycle.closure.ingredients[0].lifecycleScripts = "isolated-failed";
    expect(pantryRevisionIsCommittable(failedLifecycle)).toBe(false);
  });

  it("uses opaque build IDs and closed typed error retry/status defaults", () => {
    expect(pantryBuildIdSchema.safeParse("pbuild_0123456789abcdefghijklmn").success).toBe(true);
    expect(pantryBuildIdSchema.safeParse("42").success).toBe(false);
    for (const [code, defaults] of Object.entries(PANTRY_ERROR_DEFAULTS)) {
      const error = {
        ok: false as const,
        code,
        message: "Sanitized Pantry failure",
        retryable: defaults.retryable,
        requestId: "pantry-request-0001",
        buildId: null,
      };
      expect(pantryErrorResponseSchema.safeParse(error).success).toBe(true);
      expect(pantryErrorStatus(code as keyof typeof PANTRY_ERROR_DEFAULTS)).toBe(defaults.status);
      expect(
        pantryErrorResponseSchema.safeParse({ ...error, retryable: !defaults.retryable }).success,
      ).toBe(false);
    }
    expect(
      pantryErrorResponseSchema.safeParse({
        ok: false,
        code: "mystery_failure",
        message: "unknown",
        retryable: true,
        requestId: "pantry-request-0001",
        buildId: null,
      }).success,
    ).toBe(false);
  });

  it("keeps all v1 record formats explicit and strict", async () => {
    const records = await compatibilityRecords();
    const buildInput = pantryCompatibilityBuildInput(
      PANTRY_COMPATIBILITY_EXPECTED.closureSha256,
      PANTRY_COMPATIBILITY_EXPECTED.revisionRootSha256,
    );
    expect(PANTRY_CLOSURE_FORMAT).toBe("nabu-pantry-closure/v1");
    expect(PANTRY_REVISION_FORMAT).toBe("nabu-pantry-revision/v1");
    expect(PANTRY_LAYER_FORMAT).toBe("nabu-pantry-layer/v1");
    expect(PANTRY_BUILD_INPUT_FORMAT).toBe("nabu-pantry-build-input/v1");
    expect(PANTRY_BUILD_ATTESTATION_FORMAT).toBe("nabu-pantry-build-attestation/v1");
    expect(
      pantryRevisionRecordSchema.safeParse({ ...records.revision, unexpected: true }).success,
    ).toBe(false);
    expect(pantryBuildInputSchema.safeParse({ ...buildInput, unexpected: true }).success).toBe(
      false,
    );
  });
});
