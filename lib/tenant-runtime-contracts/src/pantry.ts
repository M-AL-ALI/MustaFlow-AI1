import { z } from "zod";
import { compareUtf8, validateRuntimeArtifactPath } from "./runtime-artifact";
import { sha256Hex } from "./request-signing";

export const PANTRY_SCHEMA_VERSION = 1 as const;
export const PANTRY_CLOSURE_FORMAT = "nabu-pantry-closure/v1" as const;
export const PANTRY_REVISION_FORMAT = "nabu-pantry-revision/v1" as const;
export const PANTRY_LAYER_FORMAT = "nabu-pantry-layer/v1" as const;
export const PANTRY_BUILD_INPUT_FORMAT = "nabu-pantry-build-input/v1" as const;
export const PANTRY_BUILD_ATTESTATION_FORMAT = "nabu-pantry-build-attestation/v1" as const;
export const PANTRY_SIGNATURE_ALGORITHM = "ES256" as const;

const PANTRY_HASH_DOMAIN = "NABUFLOW_PANTRY_V1";
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const SHA512_SRI_PATTERN = /^sha512-([A-Za-z0-9+/]{86}==)$/u;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/u;
const PACKAGE_NAME_PATTERN =
  /^(?:@[a-z0-9][a-z0-9._~-]*\/[a-z0-9][a-z0-9._~-]*|[a-z0-9][a-z0-9._~-]*)$/u;
const EXACT_SEMVER_PATTERN =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;
const REVISION_ID_PATTERN = /^pantry-\d{4}-\d{2}-\d{2}\.[1-9]\d*$/u;
const OPAQUE_BUILD_ID_PATTERN = /^pbuild_[A-Za-z0-9_-]{22,128}$/u;
const KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const ASCII_TOKEN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/u;
const encoder = new TextEncoder();

export const pantrySha256Schema = z.string().regex(SHA256_PATTERN);
export const pantryRevisionIdSchema = z.string().regex(REVISION_ID_PATTERN);
export const pantryBuildIdSchema = z.string().regex(OPAQUE_BUILD_ID_PATTERN);
export const pantryKeyIdSchema = z.string().regex(KEY_ID_PATTERN);

function isWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function assertCanonicalString(value: string, label: string): void {
  if (!isWellFormedUnicode(value) || value.normalize("NFC") !== value) {
    throw new Error(`${label} must be well-formed NFC Unicode`);
  }
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

/**
 * Pantry canonical JSON is deliberately narrower than general JSON: strings
 * and keys are NFC, object keys sort by UTF-8 bytes, and numbers are safe
 * integers (including a rejection for negative zero). Undefined values and
 * non-plain objects are rejected instead of being silently discarded.
 */
export function canonicalPantryJson(value: unknown): string {
  if (value === null || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "string") {
    assertCanonicalString(value, "Canonical JSON string");
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || Object.is(value, -0)) {
      throw new Error("Canonical Pantry JSON numbers must be safe non-negative-zero integers");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalPantryJson(entry)).join(",")}]`;
  }
  if (typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error("Canonical Pantry JSON requires plain objects");
    }
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record);
    for (const key of keys) {
      assertCanonicalString(key, "Canonical JSON object key");
      if (record[key] === undefined) {
        throw new Error("Canonical Pantry JSON cannot encode undefined values");
      }
    }
    keys.sort(compareUtf8);
    return `{${keys
      .map((key) => `${JSON.stringify(key)}:${canonicalPantryJson(record[key])}`)
      .join(",")}}`;
  }
  throw new Error("Canonical Pantry JSON received an unsupported value");
}

async function domainHash(kind: string, value: string): Promise<string> {
  return sha256Hex(`${PANTRY_HASH_DOMAIN}\n${kind}\n${value}`);
}

function decodeBase64(value: string): Uint8Array<ArrayBuffer> | null {
  try {
    return binaryToBytes(atob(value));
  } catch {
    return null;
  }
}

function decodeBase64Url(value: string): Uint8Array<ArrayBuffer> | null {
  if (!BASE64URL_PATTERN.test(value)) return null;
  const padding = "=".repeat((4 - (value.length % 4)) % 4);
  return decodeBase64(value.replace(/-/gu, "+").replace(/_/gu, "/") + padding);
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/gu, "");
}

const exactPackageNameSchema = z.string().min(1).max(214).regex(PACKAGE_NAME_PATTERN);
const exactPackageVersionSchema = z.string().min(1).max(128).regex(EXACT_SEMVER_PATTERN);
const npmIntegritySchema = z
  .string()
  .regex(SHA512_SRI_PATTERN)
  .refine((value) => {
    const encoded = SHA512_SRI_PATTERN.exec(value)?.[1];
    return encoded !== undefined && decodeBase64(encoded)?.byteLength === 64;
  }, "npm integrity must be one normalized SHA-512 SRI digest");
const httpsUrlSchema = z
  .string()
  .url()
  .max(2_000)
  .refine((value) => {
    const url = new URL(value);
    return url.protocol === "https:" && url.username === "" && url.password === "";
  }, "Resolved package URLs must use credential-free HTTPS");

/** Untrusted selectors may be ranges or dist-tags; they never enter a shelf. */
export const pantryPackageIntentSchema = z
  .object({
    ecosystem: z.literal("npm"),
    name: exactPackageNameSchema,
    selector: z
      .string()
      .min(1)
      .max(128)
      .refine((value) => !hasControlCharacter(value)),
  })
  .strict();

export const pantryPackageCoordinateSchema = z
  .object({
    ecosystem: z.literal("npm"),
    name: exactPackageNameSchema,
    version: exactPackageVersionSchema,
  })
  .strict();

export const pantryPlatformSchema = z
  .object({
    runtime: z.literal("node"),
    runtimeVersion: exactPackageVersionSchema,
    nodeAbi: z.string().regex(/^[1-9]\d{0,4}$/u),
    os: z.enum(["linux", "darwin", "win32"]),
    cpu: z.enum(["x64", "arm64"]),
    libc: z.enum(["glibc", "musl", "none"]),
    toolchainImageDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
  })
  .strict()
  .superRefine((platform, context) => {
    if (platform.os === "linux" && platform.libc === "none") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["libc"],
        message: "Linux Pantry platforms must name their libc",
      });
    }
    if (platform.os !== "linux" && platform.libc !== "none") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["libc"],
        message: "Non-Linux Pantry platforms must use libc=none",
      });
    }
  });

const pantryDependencyEdgeSchema = z
  .object({
    name: exactPackageNameSchema,
    version: exactPackageVersionSchema,
    kind: z.enum(["runtime", "optional", "peer"]),
  })
  .strict();

export const pantryProvenanceSchema = z
  .object({
    status: z.enum(["verified", "unavailable", "unverified", "rejected"]),
    attestationSha256: pantrySha256Schema.nullable(),
    registrySignatureVerified: z.boolean(),
  })
  .strict()
  .superRefine((provenance, context) => {
    if (provenance.status === "verified" && provenance.attestationSha256 === null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["attestationSha256"],
        message: "Verified provenance requires an attestation digest",
      });
    }
  });

export const pantryScannerPolicySchema = z
  .object({
    policyVersion: z.string().min(1).max(128).regex(ASCII_TOKEN_PATTERN),
    secretScan: z.enum(["passed", "warning", "failed"]),
    malwareScan: z.enum(["passed", "warning", "failed"]),
    vulnerabilityScan: z.enum(["passed", "warning", "failed"]),
    licenseScan: z.enum(["passed", "warning", "failed"]),
  })
  .strict();

export const pantryResolvedIngredientSchema = z
  .object({
    package: pantryPackageCoordinateSchema,
    registryMetadataSha256: pantrySha256Schema,
    tarballUrl: httpsUrlSchema,
    integrity: npmIntegritySchema,
    tarballSha256: pantrySha256Schema,
    normalizedContentSha256: pantrySha256Schema,
    publishTime: z.string().datetime({ offset: true }),
    deprecated: z.boolean(),
    dependencies: z.array(pantryDependencyEdgeSchema).max(10_000),
    bins: z
      .record(
        z
          .string()
          .min(1)
          .max(128)
          .regex(/^[A-Za-z0-9@][A-Za-z0-9@._-]*$/u),
        z
          .string()
          .min(1)
          .max(1_024)
          .refine(
            (path) =>
              !path.startsWith("/") &&
              !path.includes("\\") &&
              path
                .replace(/^\.\//u, "")
                .split("/")
                .every((segment) => segment !== "" && segment !== "." && segment !== ".."),
            "Package bin paths must remain relative to the package root",
          ),
      )
      .optional(),
    lifecycleScripts: z.enum(["absent", "disabled", "isolated-passed", "isolated-failed"]),
    provenance: pantryProvenanceSchema,
    scan: pantryScannerPolicySchema,
  })
  .strict()
  .superRefine((ingredient, context) => {
    let previous: string | null = null;
    for (let index = 0; index < ingredient.dependencies.length; index += 1) {
      const dependency = ingredient.dependencies[index];
      const key = `${dependency.name}@${dependency.version}\0${dependency.kind}`;
      if (previous !== null && compareUtf8(previous, key) >= 0) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["dependencies", index],
          message: "Dependency edges must be unique and sorted by UTF-8 bytes",
        });
      }
      previous = key;
    }
  });

function coordinateKey(coordinate: z.infer<typeof pantryPackageCoordinateSchema>): string {
  return `${coordinate.ecosystem}:${coordinate.name}@${coordinate.version}`;
}

export const pantryDependencyClosureSchema = z
  .object({
    format: z.literal(PANTRY_CLOSURE_FORMAT),
    schemaVersion: z.literal(PANTRY_SCHEMA_VERSION),
    platform: pantryPlatformSchema,
    roots: z.array(pantryPackageCoordinateSchema).min(1).max(1_000),
    ingredients: z.array(pantryResolvedIngredientSchema).min(1).max(100_000),
  })
  .strict()
  .superRefine((closure, context) => {
    const ingredientKeys = new Set<string>();
    let previousIngredient: string | null = null;
    for (let index = 0; index < closure.ingredients.length; index += 1) {
      const key = coordinateKey(closure.ingredients[index].package);
      if (
        ingredientKeys.has(key) ||
        (previousIngredient !== null && compareUtf8(previousIngredient, key) >= 0)
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["ingredients", index, "package"],
          message: "Resolved ingredients must be unique and sorted by exact coordinate",
        });
      }
      ingredientKeys.add(key);
      previousIngredient = key;
    }

    let previousRoot: string | null = null;
    for (let index = 0; index < closure.roots.length; index += 1) {
      const key = coordinateKey(closure.roots[index]);
      if (!ingredientKeys.has(key)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["roots", index],
          message: "Every root must resolve to an ingredient in the closure",
        });
      }
      if (previousRoot !== null && compareUtf8(previousRoot, key) >= 0) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["roots", index],
          message: "Closure roots must be unique and sorted by exact coordinate",
        });
      }
      previousRoot = key;
    }

    for (
      let ingredientIndex = 0;
      ingredientIndex < closure.ingredients.length;
      ingredientIndex += 1
    ) {
      for (
        let edgeIndex = 0;
        edgeIndex < closure.ingredients[ingredientIndex].dependencies.length;
        edgeIndex += 1
      ) {
        const edge = closure.ingredients[ingredientIndex].dependencies[edgeIndex];
        if (!ingredientKeys.has(`npm:${edge.name}@${edge.version}`)) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["ingredients", ingredientIndex, "dependencies", edgeIndex],
            message: "Every dependency edge must resolve inside the exact closure",
          });
        }
      }
    }
  });

export async function pantryDependencyClosureHash(input: PantryDependencyClosure): Promise<string> {
  const closure = pantryDependencyClosureSchema.parse(input);
  return domainHash("closure", canonicalPantryJson(closure));
}

/**
 * Leaves are exact resolved ingredient records. Nodes are domain-separated
 * pairs of lowercase hex digests; an odd final node is duplicated. The empty
 * tree has its own domain hash, although a valid closure is never empty.
 */
export async function pantryIngredientMerkleRoot(input: PantryDependencyClosure): Promise<string> {
  const closure = pantryDependencyClosureSchema.parse(input);
  let level = await Promise.all(
    closure.ingredients.map((ingredient) =>
      domainHash("ingredient-leaf", canonicalPantryJson(ingredient)),
    ),
  );
  if (level.length === 0) return domainHash("ingredient-empty", "");
  while (level.length > 1) {
    const next: string[] = [];
    for (let index = 0; index < level.length; index += 2) {
      const left = level[index];
      const right = level[index + 1] ?? left;
      next.push(await domainHash("ingredient-node", `${left}\n${right}`));
    }
    level = next;
  }
  return level[0];
}

export const pantryLayerDescriptorSchema = z
  .object({
    format: z.literal(PANTRY_LAYER_FORMAT),
    schemaVersion: z.literal(PANTRY_SCHEMA_VERSION),
    contentSha256: pantrySha256Schema,
    unpackedManifestSha256: pantrySha256Schema,
    compression: z.enum(["none", "gzip", "zstd"]),
    contentBytes: z.number().int().nonnegative().safe(),
    unpackedBytes: z.number().int().nonnegative().safe(),
    fileCount: z.number().int().nonnegative().safe(),
    mountPath: z
      .string()
      .refine(
        (path) => validateRuntimeArtifactPath(path) !== null,
        "Layer mount paths must be normalized artifact-relative paths",
      ),
    platform: pantryPlatformSchema,
  })
  .strict();

export async function pantryLayerDescriptorHash(input: PantryLayerDescriptor): Promise<string> {
  return domainHash(
    "layer-descriptor",
    canonicalPantryJson(pantryLayerDescriptorSchema.parse(input)),
  );
}

export const pantryCapturedBuildResourceSchema = z
  .object({
    url: httpsUrlSchema,
    contentSha256: pantrySha256Schema,
    bytes: z
      .number()
      .int()
      .positive()
      .max(32 * 1024 * 1024),
    mediaType: z
      .string()
      .min(1)
      .max(200)
      .regex(/^[\x20-\x7e]+$/u),
  })
  .strict();

export const pantryRevisionContentSchema = z
  .object({
    format: z.literal(PANTRY_REVISION_FORMAT),
    schemaVersion: z.literal(PANTRY_SCHEMA_VERSION),
    revisionId: pantryRevisionIdSchema,
    createdAt: z.string().datetime({ offset: true }),
    parentRootSha256: pantrySha256Schema.nullable(),
    closure: pantryDependencyClosureSchema,
    dependencyClosureSha256: pantrySha256Schema,
    ingredientMerkleRootSha256: pantrySha256Schema,
    layers: z.array(pantryLayerDescriptorSchema).max(10_000),
    scannerPolicy: pantryScannerPolicySchema,
    provenanceStatus: z.enum(["verified", "mixed", "unavailable", "rejected"]),
    capturedBuildResources: z.array(pantryCapturedBuildResourceSchema).max(1_000).optional(),
  })
  .strict()
  .superRefine((revision, context) => {
    let previousPath: string | null = null;
    const contentHashes = new Set<string>();
    for (let index = 0; index < revision.layers.length; index += 1) {
      const layer = revision.layers[index];
      if (previousPath !== null && compareUtf8(previousPath, layer.mountPath) >= 0) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["layers", index, "mountPath"],
          message: "Layer mount paths must be unique and sorted by UTF-8 bytes",
        });
      }
      if (contentHashes.has(layer.contentSha256)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["layers", index, "contentSha256"],
          message: "A revision cannot contain the same layer twice",
        });
      }
      previousPath = layer.mountPath;
      contentHashes.add(layer.contentSha256);
    }
    let previousResource: string | null = null;
    const resourceHashes = new Set<string>();
    for (let index = 0; index < (revision.capturedBuildResources?.length ?? 0); index += 1) {
      const resource = revision.capturedBuildResources?.[index];
      if (resource === undefined) continue;
      const key = `${resource.url}\0${resource.contentSha256}`;
      if (
        resourceHashes.has(resource.contentSha256) ||
        (previousResource !== null && compareUtf8(previousResource, key) >= 0)
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["capturedBuildResources", index],
          message: "Captured build resources must be unique and sorted",
        });
      }
      resourceHashes.add(resource.contentSha256);
      previousResource = key;
    }
  });

export async function pantryRevisionRoot(input: PantryRevisionContent): Promise<string> {
  return domainHash("revision-root", canonicalPantryJson(pantryRevisionContentSchema.parse(input)));
}

export const pantrySignedDigestSchema = z
  .object({
    schemaVersion: z.literal(PANTRY_SCHEMA_VERSION),
    algorithm: z.literal(PANTRY_SIGNATURE_ALGORITHM),
    kind: z.enum(["revision", "build-attestation", "shelf-content-hashes"]),
    kid: pantryKeyIdSchema,
    payloadSha256: pantrySha256Schema,
    signature: z
      .string()
      .regex(BASE64URL_PATTERN)
      .refine(
        (value) => decodeBase64Url(value)?.byteLength === 64,
        "ES256 signatures must use raw 64-byte IEEE P1363 encoding",
      ),
  })
  .strict();

export const pantryRevisionRecordSchema = z
  .object({
    content: pantryRevisionContentSchema,
    rootSha256: pantrySha256Schema,
    signature: pantrySignedDigestSchema,
  })
  .strict()
  .superRefine((record, context) => {
    if (record.signature.kind !== "revision") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["signature", "kind"],
        message: "Revision records require a revision signature",
      });
    }
  });

export const PANTRY_REVISION_STATES = [
  "assembling",
  "committed",
  "quarantined",
  "retired",
] as const;

export const pantryRevisionStateSchema = z
  .object({
    schemaVersion: z.literal(PANTRY_SCHEMA_VERSION),
    revisionId: pantryRevisionIdSchema,
    rootSha256: pantrySha256Schema,
    state: z.enum(PANTRY_REVISION_STATES),
    stateRevision: z.number().int().nonnegative().safe(),
    updatedAt: z.string().datetime({ offset: true }),
  })
  .strict();

const REVISION_TRANSITIONS: Readonly<
  Record<PantryRevisionStateName, readonly PantryRevisionStateName[]>
> = {
  assembling: ["committed", "quarantined", "retired"],
  committed: ["quarantined", "retired"],
  quarantined: ["retired"],
  retired: [],
};

export function pantryRevisionTransitionIsValid(
  previous: PantryRevisionState,
  next: PantryRevisionState,
): boolean {
  const fromResult = pantryRevisionStateSchema.safeParse(previous);
  const toResult = pantryRevisionStateSchema.safeParse(next);
  if (!fromResult.success || !toResult.success) return false;
  const from = fromResult.data;
  const to = toResult.data;
  return (
    from.revisionId === to.revisionId &&
    from.rootSha256 === to.rootSha256 &&
    to.stateRevision === from.stateRevision + 1 &&
    REVISION_TRANSITIONS[from.state].includes(to.state)
  );
}

export function pantryRevisionIsCommittable(content: PantryRevisionContent): boolean {
  const result = pantryRevisionContentSchema.safeParse(content);
  if (!result.success) return false;
  const parsed = result.data;
  return (
    parsed.provenanceStatus !== "rejected" &&
    parsed.scannerPolicy.secretScan !== "failed" &&
    parsed.scannerPolicy.malwareScan !== "failed" &&
    parsed.scannerPolicy.vulnerabilityScan !== "failed" &&
    parsed.scannerPolicy.licenseScan !== "failed" &&
    parsed.closure.ingredients.every(
      (ingredient) =>
        ingredient.provenance.status !== "rejected" &&
        ingredient.lifecycleScripts !== "isolated-failed" &&
        ingredient.scan.secretScan !== "failed" &&
        ingredient.scan.malwareScan !== "failed" &&
        ingredient.scan.vulnerabilityScan !== "failed" &&
        ingredient.scan.licenseScan !== "failed",
    )
  );
}

const argvEntrySchema = z
  .string()
  .max(16_384)
  .refine((value) => !value.includes("\0"), "Build argv entries cannot contain NUL bytes");

export const pantryBuildInputSchema = z
  .object({
    format: z.literal(PANTRY_BUILD_INPUT_FORMAT),
    schemaVersion: z.literal(PANTRY_SCHEMA_VERSION),
    buildId: pantryBuildIdSchema,
    sourceArtifactSha256: pantrySha256Schema,
    dependencyIntentSha256: pantrySha256Schema,
    lockfileSha256: pantrySha256Schema,
    pantryRevisionId: pantryRevisionIdSchema,
    pantryRevisionRootSha256: pantrySha256Schema,
    dependencyClosureSha256: pantrySha256Schema,
    platform: pantryPlatformSchema,
    buildCommand: z.array(argvEntrySchema).min(1).max(256),
    createdAt: z.string().datetime({ offset: true }),
  })
  .strict();

export async function pantryBuildInputHash(input: PantryBuildInput): Promise<string> {
  return domainHash("build-input", canonicalPantryJson(pantryBuildInputSchema.parse(input)));
}

export const pantryBuildAttestationStatementSchema = z
  .object({
    format: z.literal(PANTRY_BUILD_ATTESTATION_FORMAT),
    schemaVersion: z.literal(PANTRY_SCHEMA_VERSION),
    buildId: pantryBuildIdSchema,
    buildInputSha256: pantrySha256Schema,
    pantryRevisionId: pantryRevisionIdSchema,
    pantryRevisionRootSha256: pantrySha256Schema,
    dependencyClosureSha256: pantrySha256Schema,
    lockfileSha256: pantrySha256Schema,
    outputArtifactSha256: pantrySha256Schema,
    layerDescriptorSha256: z.array(pantrySha256Schema).max(10_000),
    sbomSha256: pantrySha256Schema,
    platform: pantryPlatformSchema,
    scannerPolicy: pantryScannerPolicySchema,
    provenanceStatus: z.enum(["verified", "mixed", "unavailable"]),
    reproducibleOffline: z.literal(true),
    issuedAt: z.string().datetime({ offset: true }),
  })
  .strict()
  .superRefine((statement, context) => {
    for (let index = 1; index < statement.layerDescriptorSha256.length; index += 1) {
      if (
        compareUtf8(
          statement.layerDescriptorSha256[index - 1],
          statement.layerDescriptorSha256[index],
        ) >= 0
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["layerDescriptorSha256", index],
          message: "Layer descriptor digests must be unique and sorted",
        });
      }
    }
  });

export async function pantryBuildAttestationHash(
  input: PantryBuildAttestationStatement,
): Promise<string> {
  return domainHash(
    "build-attestation",
    canonicalPantryJson(pantryBuildAttestationStatementSchema.parse(input)),
  );
}

export const pantryBuildAttestationSchema = z
  .object({
    statement: pantryBuildAttestationStatementSchema,
    statementSha256: pantrySha256Schema,
    signature: pantrySignedDigestSchema,
  })
  .strict()
  .superRefine((record, context) => {
    if (record.signature.kind !== "build-attestation") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["signature", "kind"],
        message: "Build attestations require a build-attestation signature",
      });
    }
  });

function binaryToBytes(binary: string): Uint8Array<ArrayBuffer> {
  const output = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) {
    output[index] = binary.charCodeAt(index);
  }
  return output;
}

function pemBytes(pem: string, label: "PRIVATE KEY" | "PUBLIC KEY"): ArrayBuffer {
  const pattern = new RegExp(
    `^-----BEGIN ${label}-----\\s+([A-Za-z0-9+/=\\s]+)\\s+-----END ${label}-----$`,
  );
  const match = pattern.exec(pem.trim());
  if (!match) throw new Error(`Pantry ${label.toLowerCase()} must be PEM encoded`);
  return binaryToBytes(atob(match[1].replace(/\s/gu, ""))).buffer;
}

async function importPantryPrivateKey(pem: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "pkcs8",
    pemBytes(pem, "PRIVATE KEY"),
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
}

async function importPantryPublicKey(pem: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "spki",
    pemBytes(pem, "PUBLIC KEY"),
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  );
}

type PantrySignatureKind = z.infer<typeof pantrySignedDigestSchema>["kind"];

export function pantrySigningInput(
  input: PantrySignedDigest | Omit<PantrySignedDigest, "signature">,
): string {
  const unsigned = pantrySignedDigestSchema.omit({ signature: true }).parse({
    schemaVersion: input.schemaVersion,
    algorithm: input.algorithm,
    kind: input.kind,
    kid: input.kid,
    payloadSha256: input.payloadSha256,
  });
  return canonicalPantryJson(unsigned);
}

export async function signPantryDigest(
  privateKeyPem: string,
  input: { kind: PantrySignatureKind; kid: string; payloadSha256: string },
): Promise<PantrySignedDigest> {
  const unsigned = pantrySignedDigestSchema.omit({ signature: true }).parse({
    schemaVersion: PANTRY_SCHEMA_VERSION,
    algorithm: PANTRY_SIGNATURE_ALGORITHM,
    ...input,
  });
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    await importPantryPrivateKey(privateKeyPem),
    encoder.encode(pantrySigningInput(unsigned)),
  );
  return pantrySignedDigestSchema.parse({
    ...unsigned,
    signature: encodeBase64Url(new Uint8Array(signature)),
  });
}

export type PantrySignatureVerification =
  | { ok: true }
  | { ok: false; reason: "malformed" | "unknown_kid" | "invalid_signature" };

export async function verifyPantryDigestSignature(
  publicKeys: ReadonlyMap<string, string>,
  input: PantrySignedDigest,
): Promise<PantrySignatureVerification> {
  const parsed = pantrySignedDigestSchema.safeParse(input);
  if (!parsed.success) return { ok: false, reason: "malformed" };
  const publicKeyPem = publicKeys.get(parsed.data.kid);
  if (publicKeyPem === undefined) return { ok: false, reason: "unknown_kid" };
  const signature = decodeBase64Url(parsed.data.signature);
  if (signature === null || signature.byteLength !== 64) {
    return { ok: false, reason: "malformed" };
  }
  try {
    const { signature: _signature, ...unsigned } = parsed.data;
    const valid = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      await importPantryPublicKey(publicKeyPem),
      signature,
      encoder.encode(pantrySigningInput(unsigned)),
    );
    return valid ? { ok: true } : { ok: false, reason: "invalid_signature" };
  } catch {
    return { ok: false, reason: "malformed" };
  }
}

export type PantryRecordVerification =
  | { ok: true }
  | {
      ok: false;
      reason:
        | "malformed"
        | "content_hash_mismatch"
        | "platform_mismatch"
        | "unknown_kid"
        | "invalid_signature";
    };

export async function verifyPantryRevisionRecord(
  input: PantryRevisionRecord,
  publicKeys: ReadonlyMap<string, string>,
): Promise<PantryRecordVerification> {
  const parsed = pantryRevisionRecordSchema.safeParse(input);
  if (!parsed.success) return { ok: false, reason: "malformed" };
  const closureHash = await pantryDependencyClosureHash(parsed.data.content.closure);
  const merkleRoot = await pantryIngredientMerkleRoot(parsed.data.content.closure);
  const root = await pantryRevisionRoot(parsed.data.content);
  if (
    closureHash !== parsed.data.content.dependencyClosureSha256 ||
    merkleRoot !== parsed.data.content.ingredientMerkleRootSha256 ||
    root !== parsed.data.rootSha256 ||
    parsed.data.signature.payloadSha256 !== root
  ) {
    return { ok: false, reason: "content_hash_mismatch" };
  }
  return verifyPantryDigestSignature(publicKeys, parsed.data.signature);
}

export async function verifyPantryBuildAttestation(
  input: PantryBuildAttestation,
  publicKeys: ReadonlyMap<string, string>,
  expectedPlatform?: PantryPlatform,
): Promise<PantryRecordVerification> {
  const parsed = pantryBuildAttestationSchema.safeParse(input);
  if (!parsed.success) return { ok: false, reason: "malformed" };
  if (
    expectedPlatform !== undefined &&
    canonicalPantryJson(pantryPlatformSchema.parse(expectedPlatform)) !==
      canonicalPantryJson(parsed.data.statement.platform)
  ) {
    return { ok: false, reason: "platform_mismatch" };
  }
  const statementHash = await pantryBuildAttestationHash(parsed.data.statement);
  if (
    statementHash !== parsed.data.statementSha256 ||
    parsed.data.signature.payloadSha256 !== statementHash
  ) {
    return { ok: false, reason: "content_hash_mismatch" };
  }
  return verifyPantryDigestSignature(publicKeys, parsed.data.signature);
}

export const PANTRY_ERROR_DEFAULTS = {
  invalid_package_intent: { retryable: false, status: 400 },
  package_not_found: { retryable: false, status: 404 },
  version_not_found: { retryable: false, status: 404 },
  integrity_mismatch: { retryable: false, status: 422 },
  provenance_rejected: { retryable: false, status: 422 },
  scan_rejected: { retryable: false, status: 422 },
  platform_unsupported: { retryable: false, status: 422 },
  dependency_conflict: { retryable: false, status: 422 },
  stocking_size_limit: { retryable: false, status: 413 },
  upstream_unavailable: { retryable: true, status: 503 },
  catalog_execution_failed: { retryable: false, status: 500 },
  ingest_timeout: { retryable: true, status: 504 },
  revision_quarantined: { retryable: false, status: 409 },
  invalid_build_input: { retryable: false, status: 400 },
  revision_not_committed: { retryable: false, status: 409 },
  layer_missing: { retryable: true, status: 503 },
  build_platform_mismatch: { retryable: false, status: 422 },
  attestation_invalid: { retryable: false, status: 422 },
  build_failed: { retryable: false, status: 422 },
  build_timeout: { retryable: true, status: 504 },
  build_resource_limit: { retryable: false, status: 422 },
  build_unavailable: { retryable: true, status: 503 },
  unknown_signing_key: { retryable: false, status: 422 },
} as const;

export const pantryErrorCodeSchema = z.enum(
  Object.keys(PANTRY_ERROR_DEFAULTS) as [
    keyof typeof PANTRY_ERROR_DEFAULTS,
    ...(keyof typeof PANTRY_ERROR_DEFAULTS)[],
  ],
);

export const pantryErrorResponseSchema = z
  .object({
    ok: z.literal(false),
    code: pantryErrorCodeSchema,
    message: z.string().min(1).max(500),
    retryable: z.boolean(),
    requestId: z.string().min(1).max(200).regex(ASCII_TOKEN_PATTERN),
    buildId: pantryBuildIdSchema.nullable(),
  })
  .strict()
  .superRefine((error, context) => {
    if (error.retryable !== PANTRY_ERROR_DEFAULTS[error.code].retryable) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["retryable"],
        message: "Pantry retryability is fixed by the typed error code",
      });
    }
  });

export function pantryErrorStatus(code: PantryErrorCode): number {
  return PANTRY_ERROR_DEFAULTS[pantryErrorCodeSchema.parse(code)].status;
}

export type PantryPackageIntent = z.infer<typeof pantryPackageIntentSchema>;
export type PantryPackageCoordinate = z.infer<typeof pantryPackageCoordinateSchema>;
export type PantryPlatform = z.infer<typeof pantryPlatformSchema>;
export type PantryResolvedIngredient = z.infer<typeof pantryResolvedIngredientSchema>;
export type PantryDependencyClosure = z.infer<typeof pantryDependencyClosureSchema>;
export type PantryLayerDescriptor = z.infer<typeof pantryLayerDescriptorSchema>;
export type PantryCapturedBuildResource = z.infer<typeof pantryCapturedBuildResourceSchema>;
export type PantryRevisionContent = z.infer<typeof pantryRevisionContentSchema>;
export type PantrySignedDigest = z.infer<typeof pantrySignedDigestSchema>;
export type PantryRevisionRecord = z.infer<typeof pantryRevisionRecordSchema>;
export type PantryRevisionStateName = (typeof PANTRY_REVISION_STATES)[number];
export type PantryRevisionState = z.infer<typeof pantryRevisionStateSchema>;
export type PantryBuildInput = z.infer<typeof pantryBuildInputSchema>;
export type PantryBuildAttestationStatement = z.infer<typeof pantryBuildAttestationStatementSchema>;
export type PantryBuildAttestation = z.infer<typeof pantryBuildAttestationSchema>;
export type PantryErrorCode = z.infer<typeof pantryErrorCodeSchema>;
export type PantryErrorResponse = z.infer<typeof pantryErrorResponseSchema>;
