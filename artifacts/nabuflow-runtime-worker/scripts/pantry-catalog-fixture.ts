import {
  PANTRY_CATALOG_SCHEMA_VERSION,
  PANTRY_CATALOG_SHELF_FORMAT,
  PANTRY_CLOSURE_FORMAT,
  PANTRY_REVISION_FORMAT,
  pantryCatalogCommitRequestSchema,
  pantryCatalogStockRequestHash,
  pantryCatalogStockRequestSchema,
  pantryDependencyClosureHash,
  pantryIngredientMerkleRoot,
  pantryRevisionRoot,
  sha256Hex,
  signPantryDigest,
  type PantryCatalogCommitRequest,
  type PantryCatalogObjectKind,
  type PantryCatalogStockRequest,
  type PantryDependencyClosure,
} from "@workspace/tenant-runtime-contracts";

/** Public test material used only by deterministic Pantry catalog acceptance. */
export const PANTRY_TEST_KEY = {
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

const PLATFORM = {
  runtime: "node" as const,
  runtimeVersion: "22.18.0",
  nodeAbi: "127",
  os: "linux" as const,
  cpu: "x64" as const,
  libc: "glibc" as const,
  toolchainImageDigest: `sha256:${"1".repeat(64)}`,
};

const SCAN = {
  policyVersion: "nabu-pantry-scan/v1",
  secretScan: "passed" as const,
  malwareScan: "passed" as const,
  vulnerabilityScan: "warning" as const,
  licenseScan: "passed" as const,
};

export interface PantryFixture {
  request: PantryCatalogStockRequest;
  commit: PantryCatalogCommitRequest;
  objects: Map<string, { kind: PantryCatalogObjectKind; bytes: Uint8Array }>;
}

export async function makePantryFixture(input?: {
  nowMs?: number;
  sequence?: number;
  parentRootSha256?: string | null;
  selector?: string;
}): Promise<PantryFixture> {
  const nowMs = input?.nowMs ?? Date.parse("2026-08-08T17:00:00.000Z");
  const createdAt = new Date(nowMs).toISOString();
  const revisionId = `pantry-${createdAt.slice(0, 10)}.${input?.sequence ?? 1}`;
  const encoder = new TextEncoder();
  const objects = new Map<string, { kind: PantryCatalogObjectKind; bytes: Uint8Array }>();
  const addObject = async (kind: PantryCatalogObjectKind, label: string): Promise<string> => {
    const bytes = encoder.encode(`fixture:${label}\n`);
    const sha256 = await sha256Hex(bytes);
    objects.set(sha256, { kind, bytes });
    return sha256;
  };
  const rootMetadata = await addObject("registry-metadata", "root-metadata");
  const rootTarball = await addObject("package-tarball", "root-tarball");
  const rootNormalized = await addObject("normalized-package", "root-normalized");
  const leafMetadata = await addObject("registry-metadata", "leaf-metadata");
  const leafTarball = await addObject("package-tarball", "leaf-tarball");
  const leafNormalized = await addObject("normalized-package", "leaf-normalized");
  const lockfileSha256 = await addObject("lockfile", "exact-lockfile");
  const sbomSha256 = await addObject("sbom", "cyclonedx-sbom");
  const toolchainAttestationSha256 = await addObject(
    "toolchain-attestation",
    "toolchain-attestation",
  );
  const integrity = `sha512-${"A".repeat(86)}==`;
  const closure: PantryDependencyClosure = {
    format: PANTRY_CLOSURE_FORMAT,
    schemaVersion: 1,
    platform: PLATFORM,
    roots: [{ ecosystem: "npm", name: "@fixture/heavy-app", version: "1.0.0" }],
    ingredients: [
      {
        package: { ecosystem: "npm", name: "@fixture/heavy-app", version: "1.0.0" },
        registryMetadataSha256: rootMetadata,
        tarballUrl: "https://registry.npmjs.org/@fixture/heavy-app/-/heavy-app-1.0.0.tgz",
        integrity,
        tarballSha256: rootTarball,
        normalizedContentSha256: rootNormalized,
        publishTime: "2026-08-01T00:00:00.000Z",
        deprecated: false,
        dependencies: [{ name: "fixture-transitive", version: "2.0.0", kind: "runtime" }],
        lifecycleScripts: "absent",
        provenance: {
          status: "unavailable",
          attestationSha256: null,
          registrySignatureVerified: false,
        },
        scan: SCAN,
      },
      {
        package: { ecosystem: "npm", name: "fixture-transitive", version: "2.0.0" },
        registryMetadataSha256: leafMetadata,
        tarballUrl: "https://registry.npmjs.org/fixture-transitive/-/fixture-transitive-2.0.0.tgz",
        integrity,
        tarballSha256: leafTarball,
        normalizedContentSha256: leafNormalized,
        publishTime: "2026-08-01T00:00:00.000Z",
        deprecated: false,
        dependencies: [],
        lifecycleScripts: "absent",
        provenance: {
          status: "unavailable",
          attestationSha256: null,
          registrySignatureVerified: false,
        },
        scan: SCAN,
      },
    ],
  };
  const dependencyClosureSha256 = await pantryDependencyClosureHash(closure);
  const ingredientMerkleRootSha256 = await pantryIngredientMerkleRoot(closure);
  const revisionContent = {
    format: PANTRY_REVISION_FORMAT,
    schemaVersion: 1 as const,
    revisionId,
    createdAt,
    parentRootSha256: input?.parentRootSha256 ?? null,
    closure,
    dependencyClosureSha256,
    ingredientMerkleRootSha256,
    layers: [],
    scannerPolicy: SCAN,
    provenanceStatus: "unavailable" as const,
  };
  const revisionRootSha256 = await pantryRevisionRoot(revisionContent);
  const revision = {
    content: revisionContent,
    rootSha256: revisionRootSha256,
    signature: await signPantryDigest(PANTRY_TEST_KEY.privateKeyPem, {
      kind: "revision",
      kid: PANTRY_TEST_KEY.kid,
      payloadSha256: revisionRootSha256,
    }),
  };
  const intentIdentity = {
    intents: [
      {
        ecosystem: "npm" as const,
        name: "@fixture/heavy-app",
        selector: input?.selector ?? "^1.0.0",
      },
    ],
    platform: PLATFORM,
  };
  const requestSha256 = await pantryCatalogStockRequestHash(intentIdentity);
  const request = pantryCatalogStockRequestSchema.parse({
    schemaVersion: PANTRY_CATALOG_SCHEMA_VERSION,
    requestSha256,
    ...intentIdentity,
    requestedAt: createdAt,
    expiresAt: new Date(nowMs + 60 * 60 * 1_000).toISOString(),
  });
  const objectReferences = [...objects.entries()]
    .map(([sha256, object]) => ({
      kind: object.kind,
      sha256,
      bytes: object.bytes.byteLength,
    }))
    .sort((left, right) => {
      const leftKey = `${left.sha256}\0${left.kind}`;
      const rightKey = `${right.sha256}\0${right.kind}`;
      return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
    });
  const assemblyId = `passembly_${requestSha256}`;
  const commit = pantryCatalogCommitRequestSchema.parse({
    format: PANTRY_CATALOG_SHELF_FORMAT,
    schemaVersion: PANTRY_CATALOG_SCHEMA_VERSION,
    assemblyId,
    revision,
    state: {
      schemaVersion: 1,
      revisionId,
      rootSha256: revisionRootSha256,
      state: "assembling",
      stateRevision: 0,
      updatedAt: createdAt,
    },
    objectReferences,
    lockfileSha256,
    sbomSha256,
    toolchainAttestationSha256,
    retention: {
      namespace: "staging-acceptance",
      retainUntil: new Date(nowMs + 2 * 60 * 60 * 1_000).toISOString(),
    },
  });
  return { request, commit, objects };
}
