import {
  PANTRY_CLOSURE_FORMAT,
  canonicalPantryJson,
  pantryDependencyClosureSchema,
  sha256Hex,
  type PantryCatalogObjectKind,
  type PantryCatalogStockRequest,
  type PantryCatalogAssemblyProgressMetrics,
  type PantryCatalogAssemblyStage,
  type PantryDependencyClosure,
  type PantryErrorCode,
  type PantryResolvedIngredient,
} from "@workspace/tenant-runtime-contracts";
import { maxSatisfying, satisfies, valid, validRange } from "semver";
import {
  NpmRegistryClient,
  PantryIngestError,
  verifyNpmRegistrySignature,
  verifyNpmSri,
  type NpmPackument,
  type NpmVersionDocument,
} from "./pantry-registry-client";
import { inspectNpmTarball } from "./pantry-tar";

const MAX_INGREDIENTS = 2_000;
const MAX_EDGES = 10_000;
const MAX_TOTAL_TARBALL_BYTES = 256 * 1024 * 1024;
const MAX_TOTAL_UNPACKED_BYTES = 1024 * 1024 * 1024;
const INGEST_TIMEOUT_MS = 120_000;
const PROGRESS_HEARTBEAT_MS = 2_000;

const SCANNER_POLICY = {
  policyVersion: "nabu-pantry-ingest-scan/v1",
  secretScan: "warning" as const,
  malwareScan: "warning" as const,
  vulnerabilityScan: "warning" as const,
  licenseScan: "warning" as const,
};

export interface PantryIngestObject {
  kind: PantryCatalogObjectKind;
  bytes: Uint8Array;
  sha256: string;
}

export interface PantryIngestProgressUpdate {
  stage: Extract<
    PantryCatalogAssemblyStage,
    | "resolving-metadata"
    | "fetching-tarball"
    | "verifying-integrity"
    | "extracting-tarball"
    | "assembling-closure"
  >;
  metrics: PantryCatalogAssemblyProgressMetrics;
}

export interface PantryIngestBuild {
  closure: PantryDependencyClosure;
  objects: PantryIngestObject[];
  lockfileSha256: string;
  sbomSha256: string;
  toolchainAttestationSha256: string;
  provenanceStatus: "mixed" | "unavailable";
}

function coordinateKey(name: string, version: string): string {
  return `npm:${name}@${version}`;
}

function orderedRecord(input: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(input).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
  );
}

export type PantryRuntimeDependencyDeclarations = ReadonlyMap<
  string,
  Pick<NpmVersionDocument, "dependencies" | "optionalDependencies">
>;

export function assertPantryClosureComplete(
  closure: PantryDependencyClosure,
  declarations: PantryRuntimeDependencyDeclarations,
): void {
  const ingredientCoordinates = new Set(
    closure.ingredients.map((ingredient) =>
      coordinateKey(ingredient.package.name, ingredient.package.version),
    ),
  );
  for (const ingredient of closure.ingredients) {
    const key = coordinateKey(ingredient.package.name, ingredient.package.version);
    const declared = declarations.get(key);
    if (declared === undefined) {
      throw new PantryIngestError(
        "dependency_conflict",
        "Pantry closure lacks immutable dependency declarations",
      );
    }
    const optionalNames = new Set(Object.keys(declared.optionalDependencies));
    const runtimeDeclarations = Object.entries(declared.dependencies).filter(
      ([name]) => !optionalNames.has(name),
    );
    const runtimeEdges = ingredient.dependencies.filter((edge) => edge.kind === "runtime");
    if (runtimeEdges.length !== runtimeDeclarations.length) {
      throw new PantryIngestError(
        "dependency_conflict",
        "Pantry closure is missing a declared runtime dependency",
      );
    }
    for (const [name, selector] of runtimeDeclarations) {
      const edge = runtimeEdges.find((candidate) => candidate.name === name);
      const selectorMatches = (() => {
        try {
          const range = validRange(selector);
          return edge !== undefined && (range === null || satisfies(edge.version, range));
        } catch {
          return false;
        }
      })();
      if (
        edge === undefined ||
        !selectorMatches ||
        !ingredientCoordinates.has(coordinateKey(edge.name, edge.version))
      ) {
        throw new PantryIngestError(
          "dependency_conflict",
          "Pantry closure is missing a declared runtime dependency",
        );
      }
    }
  }
}

function resolveVersion(packument: NpmPackument, selector: string): string {
  if (
    /^(?:https?|git\+|file|workspace|npm):/iu.test(selector) ||
    selector.includes("/") ||
    selector.includes("\\")
  ) {
    throw new PantryIngestError(
      "invalid_package_intent",
      "Only public npm versions, ranges, and dist-tags are supported",
    );
  }
  const tagged = packument.distTags[selector];
  if (tagged !== undefined && packument.versions[tagged] !== undefined) return tagged;
  if (valid(selector) !== null && packument.versions[selector] !== undefined) return selector;
  let resolved: string | null;
  try {
    resolved = maxSatisfying(Object.keys(packument.versions), selector, {
      includePrerelease: false,
    });
  } catch {
    throw new PantryIngestError("invalid_package_intent", "The npm package selector is invalid");
  }
  if (resolved === null)
    throw new PantryIngestError(
      "version_not_found",
      "No package version matched the requested selector",
    );
  return resolved;
}

function platformListAllows(values: readonly string[] | undefined, actual: string): boolean {
  if (values === undefined || values.length === 0) return true;
  if (values.includes(`!${actual}`)) return false;
  const positive = values.filter((value) => !value.startsWith("!"));
  return positive.length === 0 || positive.includes(actual);
}

function assertPlatform(document: NpmVersionDocument, request: PantryCatalogStockRequest): void {
  const platform = request.platform;
  if (
    !platformListAllows(document.os, platform.os) ||
    !platformListAllows(document.cpu, platform.cpu) ||
    !platformListAllows(document.libc, platform.libc)
  ) {
    throw new PantryIngestError(
      "platform_unsupported",
      "Package does not support the requested build platform",
    );
  }
  const nodeRange = document.engines.node;
  if (nodeRange !== undefined) {
    try {
      if (!satisfies(platform.runtimeVersion, nodeRange, { includePrerelease: true })) {
        throw new PantryIngestError(
          "platform_unsupported",
          "Package does not support the requested Node runtime",
        );
      }
    } catch (error) {
      if (error instanceof PantryIngestError) throw error;
      throw new PantryIngestError(
        "platform_unsupported",
        "Package declared an invalid Node engine range",
      );
    }
  }
}

function parseSri(integrity: string): string {
  if (!/^sha512-[A-Za-z0-9+/]{86}==$/u.test(integrity)) {
    throw new PantryIngestError(
      "integrity_mismatch",
      "Package did not publish one normalized SHA-512 integrity digest",
    );
  }
  return integrity;
}

async function objectFor(
  kind: PantryCatalogObjectKind,
  bytes: Uint8Array,
): Promise<PantryIngestObject> {
  return { kind, bytes, sha256: await sha256Hex(bytes) };
}

function parsePublishedAt(value: string | undefined): string {
  if (value === undefined || !Number.isFinite(Date.parse(value))) {
    throw new PantryIngestError(
      "upstream_unavailable",
      "Package publication time was unavailable",
      true,
    );
  }
  return new Date(value).toISOString();
}

export async function ingestPantryStockRequest(
  request: PantryCatalogStockRequest,
  client = new NpmRegistryClient(),
  now = (): number => Date.now(),
  onProgress: (progress: PantryIngestProgressUpdate) => Promise<void> = async () => undefined,
): Promise<PantryIngestBuild> {
  const startedAt = now();
  const packuments = new Map<string, Promise<{ packument: NpmPackument; bytes: Uint8Array }>>();
  const ingredients = new Map<string, Promise<PantryResolvedIngredient>>();
  const dependencyDeclarations = new Map<
    string,
    Pick<NpmVersionDocument, "dependencies" | "optionalDependencies">
  >();
  const objects = new Map<string, PantryIngestObject>();
  const keysPromise = client.fetchRegistryKeys();
  let edgeCount = 0;
  let totalTarballBytes = 0;
  let totalUnpackedBytes = 0;
  let resolvedPackages = 0;
  let fetchedTarballs = 0;
  let verifiedTarballs = 0;
  let extractedTarballs = 0;
  let lastProgressAtMs = Number.NEGATIVE_INFINITY;
  const observedStages = new Set<PantryIngestProgressUpdate["stage"]>();

  const progressMetrics = (): PantryCatalogAssemblyProgressMetrics => ({
    resolvedPackages,
    fetchedTarballs,
    verifiedTarballs,
    extractedTarballs,
    dependencyEdges: edgeCount,
    tarballBytes: totalTarballBytes,
    unpackedBytes: totalUnpackedBytes,
  });
  const progress = async (stage: PantryIngestProgressUpdate["stage"]): Promise<void> => {
    const currentMs = now();
    if (observedStages.has(stage) && currentMs - lastProgressAtMs < PROGRESS_HEARTBEAT_MS) return;
    observedStages.add(stage);
    lastProgressAtMs = currentMs;
    await onProgress({ stage, metrics: progressMetrics() });
  };

  const addObject = async (kind: PantryCatalogObjectKind, bytes: Uint8Array): Promise<string> => {
    const object = await objectFor(kind, bytes);
    const existing = objects.get(object.sha256);
    if (
      existing !== undefined &&
      (existing.kind !== kind ||
        canonicalPantryJson([...existing.bytes]) !== canonicalPantryJson([...bytes]))
    ) {
      throw new PantryIngestError(
        "integrity_mismatch",
        "A content address resolved to conflicting package bytes",
      );
    }
    objects.set(object.sha256, object);
    return object.sha256;
  };

  const getPackument = (name: string): Promise<{ packument: NpmPackument; bytes: Uint8Array }> => {
    const existing = packuments.get(name);
    if (existing !== undefined) return existing;
    const created = client.fetchPackument(name);
    packuments.set(name, created);
    return created;
  };

  const resolve = async (
    name: string,
    selector: string,
    optional = false,
    ancestors: ReadonlySet<string> = new Set(),
  ): Promise<Pick<PantryResolvedIngredient, "package"> | PantryResolvedIngredient | null> => {
    if (now() - startedAt > INGEST_TIMEOUT_MS)
      throw new PantryIngestError(
        "ingest_timeout",
        "Package ingestion exceeded its time limit",
        true,
      );
    let packumentResult: Awaited<ReturnType<typeof getPackument>>;
    try {
      await progress("resolving-metadata");
      packumentResult = await getPackument(name);
    } catch (error) {
      if (optional && error instanceof PantryIngestError && !error.retryable) return null;
      throw error;
    }
    let version: string;
    try {
      version = resolveVersion(packumentResult.packument, selector);
    } catch (error) {
      if (optional && error instanceof PantryIngestError && !error.retryable) return null;
      throw error;
    }
    const key = coordinateKey(name, version);
    if (ancestors.has(key)) {
      return { package: { ecosystem: "npm", name, version } };
    }
    const existing = ingredients.get(key);
    if (existing !== undefined) return existing;
    if (ingredients.size >= MAX_INGREDIENTS)
      throw new PantryIngestError(
        "stocking_size_limit",
        "Dependency closure exceeded its ingredient limit",
      );

    const promise = (async (): Promise<PantryResolvedIngredient> => {
      const document = packumentResult.packument.versions[version];
      if (document === undefined)
        throw new PantryIngestError("version_not_found", "Resolved package version disappeared");
      dependencyDeclarations.set(key, {
        dependencies: document.dependencies,
        optionalDependencies: document.optionalDependencies,
      });
      try {
        assertPlatform(document, request);
      } catch (error) {
        if (optional && error instanceof PantryIngestError && error.code === "platform_unsupported")
          throw error;
        throw error;
      }
      const integrity = parseSri(document.dist.integrity);
      if (
        (document.dist.fileCount !== undefined && document.dist.fileCount > 10_000) ||
        (document.dist.unpackedSize !== undefined && document.dist.unpackedSize > 128 * 1024 * 1024)
      ) {
        throw new PantryIngestError(
          "stocking_size_limit",
          "Package metadata exceeded archive safety limits",
        );
      }
      const tarballUrl = new URL(document.dist.tarball).href;
      await progress("fetching-tarball");
      const tarballBytes = await client.fetchTarball(tarballUrl);
      fetchedTarballs += 1;
      totalTarballBytes += tarballBytes.byteLength;
      if (totalTarballBytes > MAX_TOTAL_TARBALL_BYTES)
        throw new PantryIngestError(
          "stocking_size_limit",
          "Dependency closure exceeded its compressed size limit",
        );
      await progress("verifying-integrity");
      const sri = await verifyNpmSri(tarballBytes, integrity);
      if (!sri.ok)
        throw new PantryIngestError(
          "integrity_mismatch",
          "Package tarball did not match its published integrity",
        );
      const registrySignatureVerified = await verifyNpmRegistrySignature(
        name,
        version,
        integrity,
        document.dist.signatures,
        await keysPromise,
      );
      if (!registrySignatureVerified)
        throw new PantryIngestError(
          "integrity_mismatch",
          "Package registry signature verification failed",
        );
      verifiedTarballs += 1;
      await progress("extracting-tarball");
      const verifiedTar = await inspectNpmTarball(tarballBytes);
      extractedTarballs += 1;
      totalUnpackedBytes += verifiedTar.unpackedBytes;
      if (totalUnpackedBytes > MAX_TOTAL_UNPACKED_BYTES)
        throw new PantryIngestError(
          "stocking_size_limit",
          "Dependency closure exceeded its unpacked size limit",
        );

      const metadataBytes = new TextEncoder().encode(
        canonicalPantryJson({
          format: "nabu-pantry-registry-metadata/v1",
          registry: "https://registry.npmjs.org",
          package: { name, version },
          publishedAt: parsePublishedAt(packumentResult.packument.publishTimes[version]),
          dist: {
            integrity,
            tarball: tarballUrl,
            fileCount: document.dist.fileCount ?? null,
            unpackedSize: document.dist.unpackedSize ?? null,
            registrySignatureKeyIds: document.dist.signatures
              .map((signature) => signature.keyid)
              .sort(),
          },
          dependencies: orderedRecord(document.dependencies),
          optionalDependencies: orderedRecord(document.optionalDependencies),
          peerDependencies: orderedRecord(document.peerDependencies),
          bins: orderedRecord(document.bins),
          engines: orderedRecord(document.engines),
          os: document.os ?? null,
          cpu: document.cpu ?? null,
          libc: document.libc ?? null,
          deprecated: document.deprecated,
          license: document.license ?? null,
          hasLifecycleScripts: Object.keys(document.scripts).some((script) =>
            ["preinstall", "install", "postinstall"].includes(script),
          ),
        }),
      );
      const registryMetadataSha256 = await addObject("registry-metadata", metadataBytes);
      const tarballSha256 = await addObject("package-tarball", tarballBytes);
      const normalizedContentSha256 = await addObject(
        "normalized-package",
        verifiedTar.normalizedManifest,
      );

      let provenance: PantryResolvedIngredient["provenance"] = {
        status: "unavailable",
        attestationSha256: null,
        registrySignatureVerified,
      };
      if (document.dist.attestationsUrl !== undefined) {
        const evidence = await client.fetchAttestations(
          document.dist.attestationsUrl,
          name,
          version,
          sri.sha512Hex,
        );
        const attestationSha256 = await addObject("provenance-attestation", evidence.bytes);
        provenance = {
          // The DSSE statement is structurally bound to the verified tarball. Full Sigstore
          // chain verification is deliberately not claimed by this slice.
          status: "unverified",
          attestationSha256,
          registrySignatureVerified,
        };
      }

      const dependencyInputs: Array<{
        name: string;
        selector: string;
        kind: "runtime" | "optional" | "peer";
        optional: boolean;
      }> = [];
      const optionalNames = new Set(Object.keys(document.optionalDependencies));
      for (const [dependencyName, dependencySelector] of Object.entries(document.dependencies)) {
        if (!optionalNames.has(dependencyName))
          dependencyInputs.push({
            name: dependencyName,
            selector: dependencySelector,
            kind: "runtime",
            optional: false,
          });
      }
      for (const [dependencyName, dependencySelector] of Object.entries(
        document.optionalDependencies,
      )) {
        dependencyInputs.push({
          name: dependencyName,
          selector: dependencySelector,
          kind: "optional",
          optional: true,
        });
      }
      for (const [dependencyName, dependencySelector] of Object.entries(
        document.peerDependencies,
      )) {
        dependencyInputs.push({
          name: dependencyName,
          selector: dependencySelector,
          kind: "peer",
          optional: document.peerDependenciesMeta[dependencyName]?.optional === true,
        });
      }
      dependencyInputs.sort((left, right) => {
        const a = `${left.name}\0${left.kind}`;
        const b = `${right.name}\0${right.kind}`;
        return a < b ? -1 : a > b ? 1 : 0;
      });
      const dependencies: PantryResolvedIngredient["dependencies"] = [];
      for (const dependency of dependencyInputs) {
        edgeCount += 1;
        if (edgeCount > MAX_EDGES)
          throw new PantryIngestError(
            "stocking_size_limit",
            "Dependency closure exceeded its edge limit",
          );
        try {
          const child = await resolve(
            dependency.name,
            dependency.selector,
            dependency.optional,
            new Set([...ancestors, key]),
          );
          if (child !== null)
            dependencies.push({
              name: child.package.name,
              version: child.package.version,
              kind: dependency.kind,
            });
        } catch (error) {
          if (dependency.optional && error instanceof PantryIngestError && !error.retryable)
            continue;
          throw error;
        }
      }
      dependencies.sort((left, right) => {
        const a = `${left.name}@${left.version}\0${left.kind}`;
        const b = `${right.name}@${right.version}\0${right.kind}`;
        return a < b ? -1 : a > b ? 1 : 0;
      });
      resolvedPackages += 1;
      await progress("resolving-metadata");
      return {
        package: { ecosystem: "npm", name, version },
        registryMetadataSha256,
        tarballUrl,
        integrity,
        tarballSha256,
        normalizedContentSha256,
        publishTime: parsePublishedAt(packumentResult.packument.publishTimes[version]),
        deprecated: document.deprecated,
        dependencies,
        bins: orderedRecord(document.bins),
        lifecycleScripts: Object.keys(document.scripts).some((script) =>
          ["preinstall", "install", "postinstall"].includes(script),
        )
          ? "disabled"
          : "absent",
        provenance,
        scan: {
          ...SCANNER_POLICY,
          licenseScan: document.license === undefined ? "warning" : "passed",
        },
      };
    })();
    ingredients.set(key, promise);
    try {
      return await promise;
    } catch (error) {
      ingredients.delete(key);
      if (optional && error instanceof PantryIngestError && !error.retryable) return null;
      throw error;
    }
  };

  const roots: PantryDependencyClosure["roots"] = [];
  for (const intent of request.intents) {
    const ingredient = await resolve(intent.name, intent.selector);
    if (ingredient === null)
      throw new PantryIngestError("version_not_found", "Root package did not resolve");
    roots.push(ingredient.package);
  }
  await progress("assembling-closure");
  const resolvedIngredients = await Promise.all(ingredients.values());
  roots.sort((left, right) =>
    coordinateKey(left.name, left.version).localeCompare(coordinateKey(right.name, right.version)),
  );
  resolvedIngredients.sort((left, right) =>
    coordinateKey(left.package.name, left.package.version).localeCompare(
      coordinateKey(right.package.name, right.package.version),
    ),
  );
  const closure = pantryDependencyClosureSchema.parse({
    format: PANTRY_CLOSURE_FORMAT,
    schemaVersion: 1,
    platform: request.platform,
    roots,
    ingredients: resolvedIngredients,
  });
  assertPantryClosureComplete(closure, dependencyDeclarations);

  const lockfileBytes = new TextEncoder().encode(
    canonicalPantryJson({
      format: "nabu-pantry-exact-lock/v1",
      roots: closure.roots,
      packages: closure.ingredients.map((ingredient) => ({
        package: ingredient.package,
        integrity: ingredient.integrity,
        dependencies: ingredient.dependencies,
      })),
    }),
  );
  const sbomBytes = new TextEncoder().encode(
    canonicalPantryJson({
      bomFormat: "CycloneDX",
      specVersion: "1.6",
      version: 1,
      components: closure.ingredients.map((ingredient) => ({
        type: "library",
        name: ingredient.package.name,
        version: ingredient.package.version,
        purl: `pkg:npm/${ingredient.package.name}@${ingredient.package.version}`,
        hashes: [{ alg: "SHA-512", content: ingredient.integrity.slice("sha512-".length) }],
      })),
    }),
  );
  const toolchainBytes = new TextEncoder().encode(
    canonicalPantryJson({
      format: "nabu-pantry-ingest-toolchain/v1",
      toolchainImageDigest: request.platform.toolchainImageDigest,
      registryOrigin: "https://registry.npmjs.org",
      lifecycleScriptsExecuted: false,
      sourceAllowlistUsed: false,
    }),
  );
  const lockfileSha256 = await addObject("lockfile", lockfileBytes);
  const sbomSha256 = await addObject("sbom", sbomBytes);
  const toolchainAttestationSha256 = await addObject("toolchain-attestation", toolchainBytes);
  return {
    closure,
    objects: [...objects.values()].sort((left, right) => {
      const a = `${left.sha256}\0${left.kind}`;
      const b = `${right.sha256}\0${right.kind}`;
      return a < b ? -1 : a > b ? 1 : 0;
    }),
    lockfileSha256,
    sbomSha256,
    toolchainAttestationSha256,
    provenanceStatus: closure.ingredients.every(
      (ingredient) => ingredient.provenance.status === "unavailable",
    )
      ? "unavailable"
      : "mixed",
  };
}

export function ingestErrorDefaults(error: unknown): {
  code: PantryErrorCode;
  retryable: boolean;
  message: string;
} {
  if (error instanceof PantryIngestError)
    return { code: error.code, retryable: error.retryable, message: error.message };
  return {
    code: "upstream_unavailable",
    retryable: true,
    message: "Trusted package ingestion failed",
  };
}
