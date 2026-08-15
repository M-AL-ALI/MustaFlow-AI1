import { createHash } from "node:crypto";
import {
  ZERO_GENERATION_FORMAT,
  ZERO_GENERATION_SCHEMA_VERSION,
  ZERO_SEALED_BUILD_COMMAND,
  ZERO_SEALED_DEPLOYMENT_NAMESPACE,
  ZERO_SEALED_GENERATION_GATE_ENV,
  ZERO_SEALED_GENERATION_GATE_VALUE,
  ZERO_SEALED_HEALTH_PATH,
  ZERO_PANTRY_PUBLIC_KEYS_ENV,
  ZERO_SEALED_PRODUCTION_DEPLOYMENT_NAMESPACE,
  ZERO_SEALED_PRODUCTION_GENERATION_GATE_VALUE,
  ZERO_SEALED_RUNTIME_PORT,
  ZERO_SEALED_START_COMMAND,
  zeroGeneratedDependencyPlanSchema,
  zeroSealedNodeRuntimeManifestSchema,
  type RuntimeManifestContract,
  type ZeroGeneratedDependencyPlan,
  type ZeroGenerationTarget,
  type ZeroSealedGenerationTarget,
} from "@workspace/tenant-runtime-contracts";
import type { BuilderFile } from "./builder";
import {
  VENDORED_FLY_POSTGRES_TYPES_VERSION,
  VENDORED_FLY_POSTGRES_VERSION,
  getVendoredRuntimeSdkFiles,
} from "./zero-runtime-sdk";

export const ZERO_SEALED_NODE_PROMPT_EXTENSION = `CLOUDFLARE SEALED-RUNTIME TARGET:
- Keep the source provider-neutral by importing createNabuFlowDatabase and createNabuFlowPayments as needed from "../nabuflow/runtime/index.js" in src/*.ts. Never import a database or payments provider SDK. The explicit .js suffix is required for the emitted ESM path when TypeScript uses NodeNext. The platform-owned SDK automatically injects its lazy Fly PostgreSQL adapter; application code never configures it.
- Server-side payments use createNabuFlowPayments. Sealed mode supports PaymentIntent creation and retrieval only; choose a supported implementation when another payment operation or integration is requested.
- Do not read DATABASE_URL, STRIPE_*, credentials, API keys, or secret environment variables in application code. The vendored NabuFlow runtime SDK is the only database path.
- Do not create .env files in sealed-native projects, including .env.example. Sealed apps receive no tenant credentials or secret configuration.
- Bind the HTTP server to 0.0.0.0 and Number(process.env.PORT ?? "8080").
- GET /healthz must return 200 without touching a database or any external service.
- package.json scripts are exactly build="tsc" and start="node dist/src/index.js". Set TypeScript rootDir to "." so the source-owned nabuflow module and src/ compile together. Declare every dependency normally; the trusted Pantry resolves and provisions them. Never emit npm install, npx, registry URLs, or lockfile bootstrap commands.
- The sealed artifact contains TypeScript compiler output, not source-only assets. Runtime code must not depend on public/, templates/, source JSON, or another file that plain tsc does not emit. Serve small UI assets from compiled code, or import data through a compiler-emitted module; never use express.static or sendFile for source-only paths.
- When the app declares the database capability, initialize its app-owned schema idempotently through createNabuFlowDatabase before accepting traffic (for example, CREATE TABLE IF NOT EXISTS). Do not invoke migration CLIs, read raw database credentials, or make healthz depend on schema initialization.
- The source package's Fly-compatible start script remains "node dist/src/index.js". The sealed runtime manifest is fixed at port 8080, health path /healthz, build argv ["npm","run","build"], and sealed-output start argv ["node","src/index.js"].`;

export class ZeroSealedGenerationConfigurationError extends Error {
  readonly code = "zero_sealed_generation_unavailable";

  constructor(message = "Sealed Zero generation is not enabled for this deployment") {
    super(message);
    this.name = "ZeroSealedGenerationConfigurationError";
  }
}

export type ZeroSealedSourceContractReason =
  | "required_files"
  | "package_json"
  | "runtime_scripts"
  | "typescript_config"
  | "typescript_output_layout"
  | "typescript_module_specifier"
  | "sdk_import"
  | "network_bind"
  | "runtime_port"
  | "health_route"
  | "runtime_asset_dependency"
  | "credential_or_dependency_egress";

export class ZeroSealedSourceContractError extends Error {
  readonly code = "zero_sealed_source_contract_error";
  readonly retryable = false;

  constructor(
    readonly reasons: readonly ZeroSealedSourceContractReason[],
    readonly path?: string,
  ) {
    super(`Sealed Node source contract failed: ${reasons.join(", ")}${path ? ` (${path})` : ""}`);
    this.name = "ZeroSealedSourceContractError";
  }
}

/**
 * Resolve once from deployment-owned process configuration. A user request,
 * project row, or generated file cannot select the sealed path.
 */
export function resolveZeroGenerationTarget(
  environment: Record<string, string | undefined>,
): ZeroGenerationTarget {
  const requested = environment[ZERO_SEALED_GENERATION_GATE_ENV];
  if (requested === undefined || requested === "") return "legacy-v1";
  if (environment.TENANT_RUNTIME_PROVIDER !== "cloudflare") {
    throw new ZeroSealedGenerationConfigurationError();
  }
  const namespace = environment.CLOUDFLARE_RUNTIME_DEPLOYMENT_NAMESPACE;
  if (
    requested === ZERO_SEALED_GENERATION_GATE_VALUE &&
    namespace === ZERO_SEALED_DEPLOYMENT_NAMESPACE
  ) {
    return ZERO_SEALED_GENERATION_GATE_VALUE;
  }
  if (
    requested === ZERO_SEALED_PRODUCTION_GENERATION_GATE_VALUE &&
    namespace === ZERO_SEALED_PRODUCTION_DEPLOYMENT_NAMESPACE
  ) {
    return ZERO_SEALED_PRODUCTION_GENERATION_GATE_VALUE;
  }
  throw new ZeroSealedGenerationConfigurationError();
}

/**
 * Legacy/Fly projects retain their existing direct database provisioning.
 * Sealed Cloudflare projects receive database material only through the
 * Acceptance Provisioner -> Capability Vault handoff, never a project secret.
 */
export function requiresDirectProjectDatabaseProvisioning(
  environment: Record<string, string | undefined>,
): boolean {
  return resolveZeroGenerationTarget(environment) === "legacy-v1";
}

/**
 * New sealed projects are stamped with the same fixed port carried by their
 * generated runtime manifest. Legacy/Fly rows retain the historical nullable
 * runtime-port behavior byte-for-byte.
 */
export function resolveZeroProjectRuntimePort(
  environment: Record<string, string | undefined>,
): number | null {
  return isZeroSealedGenerationTarget(resolveZeroGenerationTarget(environment))
    ? ZERO_SEALED_RUNTIME_PORT
    : null;
}

/**
 * A sealed Node application cannot be published as a snapshot-only project.
 * Legacy/Fly creation omits the field and therefore retains the database default.
 */
export function resolveZeroProjectDeploymentType(
  environment: Record<string, string | undefined>,
): "autoscale" | undefined {
  return isZeroSealedGenerationTarget(resolveZeroGenerationTarget(environment))
    ? "autoscale"
    : undefined;
}

export function readZeroPantryPublicKeys(
  environment: Record<string, string | undefined>,
): ReadonlyMap<string, string> {
  const raw = environment[ZERO_PANTRY_PUBLIC_KEYS_ENV];
  if (raw === undefined || raw.length === 0) {
    throw new ZeroSealedGenerationConfigurationError("Pantry verification keys are unavailable");
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new ZeroSealedGenerationConfigurationError("Pantry verification keys are invalid");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ZeroSealedGenerationConfigurationError("Pantry verification keys are invalid");
  }
  const entries = Object.entries(value);
  if (
    entries.length === 0 ||
    entries.some(
      ([keyId, publicKey]) =>
        !/^[A-Za-z0-9._-]{1,128}$/u.test(keyId) ||
        typeof publicKey !== "string" ||
        !publicKey.includes("BEGIN PUBLIC KEY") ||
        publicKey.includes("PRIVATE KEY"),
    )
  ) {
    throw new ZeroSealedGenerationConfigurationError("Pantry verification keys are invalid");
  }
  return new Map(entries as Array<[string, string]>);
}

export function makeZeroSealedNodeManifest(revision: string): RuntimeManifestContract {
  return zeroSealedNodeRuntimeManifestSchema.parse({
    revision,
    runtime: "node-api",
    buildCommand: [...ZERO_SEALED_BUILD_COMMAND],
    startCommand: [...ZERO_SEALED_START_COMMAND],
    servicePort: ZERO_SEALED_RUNTIME_PORT,
    healthPath: ZERO_SEALED_HEALTH_PATH,
    resourceProfile: "dev",
    public: false,
  });
}

type PackageJson = {
  [key: string]: unknown;
  scripts?: Record<string, unknown>;
  dependencies?: Record<string, unknown>;
  devDependencies?: Record<string, unknown>;
};

type TypeScriptConfig = {
  compilerOptions?: Record<string, unknown>;
};

const SECRET_ENV_PATTERN =
  /process\.env\.(?:DATABASE_URL|STRIPE_[A-Z0-9_]*|PGPASSWORD|NEON_[A-Z0-9_]*|[A-Z0-9_]*(?:TOKEN|SECRET|KEY))/u;
const INSTALL_OR_REGISTRY_PATTERN =
  /(?:\bnpx\b|\b(?:npm|pnpm|yarn|bun)\s+(?:i|install|add|dlx)\b|registry\.npmjs\.org)/u;
const SOURCE_ONLY_RUNTIME_ASSET_PATTERN = /\b(?:express\.static|[A-Za-z_$][\w$]*\.sendFile)\s*\(/u;
const SEALED_NETWORK_BIND_PATTERN =
  /\b[A-Za-z_$][\w$]*\.listen\s*\(\s*[^,\r\n]+,\s*(["'])0\.0\.0\.0\1\s*(?:,|\))/u;
const RELATIVE_MODULE_SPECIFIER_PATTERN =
  /\b(?:import|export)\s+(?:[^"'\r\n]+?\s+from\s+)?(["'])(\.{1,2}\/[^"']+)\1|\bimport\s*\(\s*(["'])(\.{1,2}\/[^"']+)\3\s*\)/gu;

function firstNodeNextModuleSpecifierFailure(files: Iterable<BuilderFile>): string | undefined {
  for (const file of files) {
    if (!/\.(?:[cm]?ts|tsx)$/u.test(file.path)) continue;
    RELATIVE_MODULE_SPECIFIER_PATTERN.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = RELATIVE_MODULE_SPECIFIER_PATTERN.exec(file.content)) !== null) {
      const specifier = match[2] ?? match[4] ?? "";
      if (!/\.(?:[cm]?js|json)$/u.test(specifier)) return file.path;
    }
  }
  return undefined;
}

function dependencyPlan(
  pkg: PackageJson,
  target: ZeroSealedGenerationTarget,
): ZeroGeneratedDependencyPlan {
  const intents = new Map<string, { ecosystem: "npm"; name: string; selector: string }>();
  for (const group of [pkg.dependencies ?? {}, pkg.devDependencies ?? {}]) {
    for (const [name, selector] of Object.entries(group)) {
      if (typeof selector !== "string" || selector.length === 0) {
        throw new Error(`Dependency ${name} has no Pantry selector`);
      }
      const prior = intents.get(name);
      if (prior !== undefined && prior.selector !== selector) {
        throw new Error(`Dependency ${name} has conflicting selectors`);
      }
      intents.set(name, { ecosystem: "npm", name, selector });
    }
  }
  return zeroGeneratedDependencyPlanSchema.parse({
    format: ZERO_GENERATION_FORMAT,
    schemaVersion: ZERO_GENERATION_SCHEMA_VERSION,
    target,
    intents: [...intents.values()].sort((left, right) => {
      const a = `${left.ecosystem}:${left.name}\0${left.selector}`;
      const b = `${right.ecosystem}:${right.name}\0${right.selector}`;
      return a < b ? -1 : a > b ? 1 : 0;
    }),
  });
}

function withVendoredRuntimeDependencies(pkg: PackageJson): PackageJson {
  return {
    ...pkg,
    dependencies: {
      ...(pkg.dependencies ?? {}),
      pg: VENDORED_FLY_POSTGRES_VERSION,
    },
    devDependencies: {
      ...(pkg.devDependencies ?? {}),
      "@types/pg": VENDORED_FLY_POSTGRES_TYPES_VERSION,
    },
  };
}

export interface PreparedZeroSealedNodeSource {
  files: BuilderFile[];
  dependencyPlan: ZeroGeneratedDependencyPlan;
  manifest: RuntimeManifestContract;
}

export interface PreparedZeroSealedNodeRefinement extends PreparedZeroSealedNodeSource {
  changedFiles: BuilderFile[];
  removedPaths: string[];
  unchangedPaths: string[];
}

export function zeroSealedNodeManifestRevision(files: readonly BuilderFile[]): string {
  const identity = [...files]
    .map((file) => ({ path: file.path, mimeType: file.mimeType, content: file.content }))
    .sort((left, right) => left.path.localeCompare(right.path));
  const sha256 = createHash("sha256")
    .update(
      JSON.stringify({
        format: ZERO_GENERATION_FORMAT,
        schemaVersion: ZERO_GENERATION_SCHEMA_VERSION,
        runtimePort: ZERO_SEALED_RUNTIME_PORT,
        healthPath: ZERO_SEALED_HEALTH_PATH,
        buildCommand: ZERO_SEALED_BUILD_COMMAND,
        startCommand: ZERO_SEALED_START_COMMAND,
        files: identity,
      }),
    )
    .digest("hex");
  return `zero-node-v1-${sha256}`;
}

export function prepareZeroSealedNodeSource(input: {
  files: readonly BuilderFile[];
  target?: ZeroSealedGenerationTarget;
  manifestRevision?: string;
  /** Product generator paths run the canonical async eligibility scanner next. */
  skipEligibilityPrecheck?: boolean;
}): PreparedZeroSealedNodeSource {
  const byPath = new Map(input.files.map((file) => [file.path, { ...file }]));
  for (const file of byPath.values()) {
    if (/(?:^|\/)\.env(?:\.|$)/u.test(file.path)) {
      throw new ZeroSealedSourceContractError(["credential_or_dependency_egress"], file.path);
    }
  }
  const packageFile = byPath.get("package.json");
  const entry = byPath.get("src/index.ts");
  const typeScriptConfigFile = byPath.get("tsconfig.json");
  if (packageFile === undefined || entry === undefined || typeScriptConfigFile === undefined) {
    throw new ZeroSealedSourceContractError(["required_files"]);
  }
  let pkg: PackageJson;
  try {
    pkg = JSON.parse(packageFile.content) as PackageJson;
  } catch {
    throw new ZeroSealedSourceContractError(["package_json"], "package.json");
  }
  if (pkg.scripts?.build !== "tsc" || pkg.scripts?.start !== "node dist/src/index.js") {
    throw new ZeroSealedSourceContractError(["runtime_scripts"], "package.json");
  }
  pkg = withVendoredRuntimeDependencies(pkg);
  byPath.set("package.json", {
    ...packageFile,
    content: `${JSON.stringify(pkg, null, 2)}\n`,
  });
  let typeScriptConfig: TypeScriptConfig;
  try {
    typeScriptConfig = JSON.parse(typeScriptConfigFile.content) as TypeScriptConfig;
  } catch {
    throw new ZeroSealedSourceContractError(["typescript_config"], "tsconfig.json");
  }
  if (
    typeScriptConfig.compilerOptions?.rootDir !== "." ||
    typeScriptConfig.compilerOptions?.outDir !== "dist"
  ) {
    throw new ZeroSealedSourceContractError(["typescript_output_layout"], "tsconfig.json");
  }
  const nodeNextModuleSpecifierFailure =
    typeScriptConfig.compilerOptions?.module === "NodeNext" ||
    typeScriptConfig.compilerOptions?.moduleResolution === "NodeNext"
      ? firstNodeNextModuleSpecifierFailure(byPath.values())
      : undefined;
  if (nodeNextModuleSpecifierFailure !== undefined) {
    throw new ZeroSealedSourceContractError(
      ["typescript_module_specifier"],
      nodeNextModuleSpecifierFailure,
    );
  }
  const entryReasons: ZeroSealedSourceContractReason[] = [];
  if (!entry.content.includes("nabuflow/runtime") || entry.content.includes(".nabuflow/runtime"))
    entryReasons.push("sdk_import");
  if (!SEALED_NETWORK_BIND_PATTERN.test(entry.content)) entryReasons.push("network_bind");
  if (!entry.content.includes("process.env.PORT")) entryReasons.push("runtime_port");
  if (!entry.content.includes(ZERO_SEALED_HEALTH_PATH)) entryReasons.push("health_route");
  if (entryReasons.length > 0) {
    throw new ZeroSealedSourceContractError(entryReasons, "src/index.ts");
  }
  for (const file of byPath.values()) {
    if (
      /\.(?:[cm]?ts|tsx)$/u.test(file.path) &&
      SOURCE_ONLY_RUNTIME_ASSET_PATTERN.test(file.content)
    ) {
      throw new ZeroSealedSourceContractError(["runtime_asset_dependency"], file.path);
    }
  }
  if (input.skipEligibilityPrecheck !== true) {
    for (const file of byPath.values()) {
      if (SECRET_ENV_PATTERN.test(file.content) || INSTALL_OR_REGISTRY_PATTERN.test(file.content)) {
        throw new ZeroSealedSourceContractError(["credential_or_dependency_egress"], file.path);
      }
    }
  }
  for (const sdkFile of getVendoredRuntimeSdkFiles()) {
    byPath.set(sdkFile.path, {
      path: sdkFile.path,
      content: sdkFile.content,
      mimeType: "application/typescript",
    });
  }
  const files = [...byPath.values()].sort((left, right) => left.path.localeCompare(right.path));
  return {
    files,
    dependencyPlan: dependencyPlan(pkg, input.target ?? ZERO_SEALED_GENERATION_GATE_VALUE),
    manifest: makeZeroSealedNodeManifest(
      input.manifestRevision ?? zeroSealedNodeManifestRevision(files),
    ),
  };
}

/**
 * Apply a refinement diff to the durable source tree before re-running the
 * sealed-source contract. The vendored SDK is platform-owned, so an upgrade or
 * first successful continuation can add/update those files without asking the
 * model to reproduce them.
 */
export function prepareZeroSealedNodeRefinement(input: {
  existingFiles: readonly BuilderFile[];
  changedFiles: readonly BuilderFile[];
  removedPaths: readonly string[];
  target?: ZeroSealedGenerationTarget;
  manifestRevision?: string;
}): PreparedZeroSealedNodeRefinement {
  const removed = new Set(input.removedPaths);
  const merged = new Map(
    input.existingFiles
      .filter((file) => !removed.has(file.path))
      .map((file) => [file.path, { ...file }]),
  );
  for (const file of input.changedFiles) merged.set(file.path, { ...file });

  const prepared = prepareZeroSealedNodeSource({
    files: [...merged.values()],
    target: input.target,
    manifestRevision: input.manifestRevision,
    skipEligibilityPrecheck: true,
  });
  const existingByPath = new Map(input.existingFiles.map((file) => [file.path, file]));
  const preparedPaths = new Set(prepared.files.map((file) => file.path));
  const isUnchanged = (file: BuilderFile): boolean => {
    const existing = existingByPath.get(file.path);
    return (
      existing !== undefined &&
      existing.content === file.content &&
      existing.mimeType === file.mimeType
    );
  };

  return {
    ...prepared,
    changedFiles: prepared.files.filter((file) => !isUnchanged(file)),
    removedPaths: input.existingFiles
      .filter((file) => !preparedPaths.has(file.path))
      .map((file) => file.path)
      .sort(),
    unchangedPaths: prepared.files.filter(isUnchanged).map((file) => file.path),
  };
}

export function isZeroSealedGenerationTarget(
  target: ZeroGenerationTarget | undefined,
): target is ZeroSealedGenerationTarget {
  return (
    target === ZERO_SEALED_GENERATION_GATE_VALUE ||
    target === ZERO_SEALED_PRODUCTION_GENERATION_GATE_VALUE
  );
}
