import type {
  PantryBuildAttestationStatement,
  PantryBuildInput,
  PantryDependencyClosure,
  PantryLayerDescriptor,
  PantryRevisionContent,
  PantrySignedDigest,
} from "../src/pantry";

/**
 * Pantry v1 compatibility fixture. The keypair is public test data only and
 * must never be used outside tests. The fixed ES256 signatures use raw IEEE
 * P1363 (r || s) bytes.
 */
export const PANTRY_COMPATIBILITY_KEY = {
  kid: "pantry-test-key-2026-08",
  privateKeyPem: `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgZqQSR1D+CC69JD0Q
g0cVWWv9GV9xRDwJACmeFbbvu9ihRANCAARccmVKOQxtA98n4Y1H6wXtU44Zh9vj
eLbrsF4RiLGT1LD3jL0agmggLIq0aXXeIO53j5U1HjWVKvOJTy3YB4on
-----END PRIVATE KEY-----
`,
  publicKeyPem: `-----BEGIN PUBLIC KEY-----
MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEXHJlSjkMbQPfJ+GNR+sF7VOOGYfb
43i267BeEYixk9Sw94y9GoJoICyKtGl13iDud4+VNR41lSrziU8t2AeKJw==
-----END PUBLIC KEY-----
`,
} as const;

const scan = {
  policyVersion: "nabu-pantry-scan/v1",
  secretScan: "passed",
  malwareScan: "passed",
  vulnerabilityScan: "warning",
  licenseScan: "passed",
} as const;

export const PANTRY_COMPATIBILITY_PLATFORM = {
  runtime: "node",
  runtimeVersion: "22.18.0",
  nodeAbi: "127",
  os: "linux",
  cpu: "x64",
  libc: "glibc",
  toolchainImageDigest: `sha256:${"1".repeat(64)}`,
} as const;

export const PANTRY_COMPATIBILITY_CLOSURE = {
  format: "nabu-pantry-closure/v1",
  schemaVersion: 1,
  platform: PANTRY_COMPATIBILITY_PLATFORM,
  roots: [{ ecosystem: "npm", name: "express", version: "5.1.0" }],
  ingredients: [
    {
      package: { ecosystem: "npm", name: "@nabu/runtime", version: "1.2.3" },
      registryMetadataSha256: "2".repeat(64),
      tarballUrl: "https://registry.npmjs.org/@nabu/runtime/-/runtime-1.2.3.tgz",
      integrity:
        "sha512-z4PhNX7vuL3xVChQ1m2AB9Yg5AULVxXcg/SpIdNs6c5H0NE8XYhgj4/2U80sDafNvcidRI8qqM/aRwlqR5JoxA==",
      tarballSha256: "3".repeat(64),
      normalizedContentSha256: "4".repeat(64),
      publishTime: "2026-08-01T00:00:00.000Z",
      deprecated: false,
      dependencies: [],
      lifecycleScripts: "absent",
      provenance: {
        status: "verified",
        attestationSha256: "5".repeat(64),
        registrySignatureVerified: true,
      },
      scan,
    },
    {
      package: { ecosystem: "npm", name: "express", version: "5.1.0" },
      registryMetadataSha256: "6".repeat(64),
      tarballUrl: "https://registry.npmjs.org/express/-/express-5.1.0.tgz",
      integrity:
        "sha512-z4PhNX7vuL3xVChQ1m2AB9Yg5AULVxXcg/SpIdNs6c5H0NE8XYhgj4/2U80sDafNvcidRI8qqM/aRwlqR5JoxA==",
      tarballSha256: "7".repeat(64),
      normalizedContentSha256: "8".repeat(64),
      publishTime: "2026-08-02T00:00:00.000Z",
      deprecated: false,
      dependencies: [{ name: "@nabu/runtime", version: "1.2.3", kind: "runtime" }],
      lifecycleScripts: "disabled",
      provenance: {
        status: "unavailable",
        attestationSha256: null,
        registrySignatureVerified: true,
      },
      scan,
    },
  ],
} satisfies PantryDependencyClosure;

export const PANTRY_COMPATIBILITY_LAYER = {
  format: "nabu-pantry-layer/v1",
  schemaVersion: 1,
  contentSha256: "9".repeat(64),
  unpackedManifestSha256: "a".repeat(64),
  compression: "zstd",
  contentBytes: 4_096,
  unpackedBytes: 16_384,
  fileCount: 17,
  mountPath: "node_modules",
  platform: PANTRY_COMPATIBILITY_PLATFORM,
} satisfies PantryLayerDescriptor;

export const PANTRY_COMPATIBILITY_EXPECTED = {
  closureSha256: "2768db3c54bb2de34adf539ddbf08cc3c915425566c1dc6231fe873bf28708d3",
  ingredientMerkleRootSha256: "67d2875d48c393bd93b669b3987f99fb2a3895861a7f155a7209a6580bf6c3b6",
  layerDescriptorSha256: "f1dbe71e25ae58fa983dfcacb97ed4ecf06009efb098e04564ec0a353c194836",
  revisionRootSha256: "0f89ad1aa02ef435291ed6c1731ec75b1cff7c8bda8a814669de1d28a959b7a1",
  buildInputSha256: "73854200f9354888cc9b50a05344ba4cc632bcdd9829015b221327f2d959a7a0",
  attestationSha256: "317d8c7722478df2be6a5d631206d781f1122d7093cd5e2cf2fcccc46cd5bc13",
  revisionSigningInput:
    '{"algorithm":"ES256","kid":"pantry-test-key-2026-08","kind":"revision","payloadSha256":"0f89ad1aa02ef435291ed6c1731ec75b1cff7c8bda8a814669de1d28a959b7a1","schemaVersion":1}',
  revisionSignature:
    "6hpArI6tJ6bB5FgmWBdx3Ul9qo3ExQ5xnlMShwR-CmGAYjWWy1VHqZgzWuZTvuW8qYa98h9GHN97pO_3VV6lcQ",
  attestationSigningInput:
    '{"algorithm":"ES256","kid":"pantry-test-key-2026-08","kind":"build-attestation","payloadSha256":"317d8c7722478df2be6a5d631206d781f1122d7093cd5e2cf2fcccc46cd5bc13","schemaVersion":1}',
  attestationSignature:
    "U645lWhxDaUUrTEoIafj8APquQyI3xJS1R0bzsf-FCHu3BW2wwwx_prYulCw13PKXtWploJ9njoX5lU5Ztvbug",
} as const;

export function pantryCompatibilityRevisionContent(
  closureSha256: string,
  ingredientMerkleRootSha256: string,
): PantryRevisionContent {
  return {
    format: "nabu-pantry-revision/v1",
    schemaVersion: 1,
    revisionId: "pantry-2026-08-07.1",
    createdAt: "2026-08-07T00:00:00.000Z",
    parentRootSha256: null,
    closure: PANTRY_COMPATIBILITY_CLOSURE,
    dependencyClosureSha256: closureSha256,
    ingredientMerkleRootSha256,
    layers: [PANTRY_COMPATIBILITY_LAYER],
    scannerPolicy: scan,
    provenanceStatus: "mixed",
  };
}

export function pantryCompatibilityBuildInput(
  closureSha256: string,
  revisionRootSha256: string,
): PantryBuildInput {
  return {
    format: "nabu-pantry-build-input/v1",
    schemaVersion: 1,
    buildId: "pbuild_0123456789abcdefghijklmn",
    sourceArtifactSha256: "b".repeat(64),
    dependencyIntentSha256: "c".repeat(64),
    lockfileSha256: "d".repeat(64),
    pantryRevisionId: "pantry-2026-08-07.1",
    pantryRevisionRootSha256: revisionRootSha256,
    dependencyClosureSha256: closureSha256,
    platform: PANTRY_COMPATIBILITY_PLATFORM,
    buildCommand: ["pnpm", "run", "build"],
    createdAt: "2026-08-07T00:01:00.000Z",
  };
}

export function pantryCompatibilityAttestation(
  buildInputSha256: string,
  closureSha256: string,
  revisionRootSha256: string,
  layerDescriptorSha256: string,
): PantryBuildAttestationStatement {
  return {
    format: "nabu-pantry-build-attestation/v1",
    schemaVersion: 1,
    buildId: "pbuild_0123456789abcdefghijklmn",
    buildInputSha256,
    pantryRevisionId: "pantry-2026-08-07.1",
    pantryRevisionRootSha256: revisionRootSha256,
    dependencyClosureSha256: closureSha256,
    lockfileSha256: "d".repeat(64),
    outputArtifactSha256: "e".repeat(64),
    layerDescriptorSha256: [layerDescriptorSha256],
    sbomSha256: "f".repeat(64),
    platform: PANTRY_COMPATIBILITY_PLATFORM,
    scannerPolicy: scan,
    provenanceStatus: "mixed",
    reproducibleOffline: true,
    issuedAt: "2026-08-07T00:02:00.000Z",
  };
}

export function fixedRevisionSignature(rootSha256: string): PantrySignedDigest {
  return {
    schemaVersion: 1,
    algorithm: "ES256",
    kind: "revision",
    kid: PANTRY_COMPATIBILITY_KEY.kid,
    payloadSha256: rootSha256,
    signature: PANTRY_COMPATIBILITY_EXPECTED.revisionSignature,
  };
}

export function fixedAttestationSignature(statementSha256: string): PantrySignedDigest {
  return {
    schemaVersion: 1,
    algorithm: "ES256",
    kind: "build-attestation",
    kid: PANTRY_COMPATIBILITY_KEY.kid,
    payloadSha256: statementSha256,
    signature: PANTRY_COMPATIBILITY_EXPECTED.attestationSignature,
  };
}
