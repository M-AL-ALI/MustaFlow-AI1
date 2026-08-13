import {
  ZERO_GENERATION_FORMAT,
  ZERO_GENERATION_SCHEMA_VERSION,
  ZERO_SEALED_BUILD_COMMAND,
  ZERO_SEALED_DEPLOYMENT_NAMESPACE,
  ZERO_SEALED_GENERATION_GATE_ENV,
  ZERO_SEALED_GENERATION_GATE_VALUE,
  ZERO_SEALED_HEALTH_PATH,
  ZERO_PANTRY_PUBLIC_KEYS_ENV,
  ZERO_SEALED_RUNTIME_PORT,
  ZERO_SEALED_START_COMMAND,
  zeroGeneratedDependencyPlanSchema,
  zeroSealedNodeRuntimeManifestSchema,
  type RuntimeManifestContract,
  type ZeroGeneratedDependencyPlan,
  type ZeroGenerationTarget,
} from "@workspace/tenant-runtime-contracts";
import type { BuilderFile } from "./builder";
import { getVendoredRuntimeSdkFiles } from "./zero-runtime-sdk";

export const ZERO_SEALED_NODE_PROMPT_EXTENSION = `CLOUDFLARE SEALED-RUNTIME TARGET (staging-only):
- Keep the source provider-neutral by importing createNabuFlowDatabase and createNabuFlowPayments as needed from "../nabuflow/runtime/index" in src/*.ts. Never import a database or payments provider SDK.
- Server-side payments use createNabuFlowPayments. Sealed mode supports PaymentIntent creation and retrieval only; choose a supported implementation when another payment operation or integration is requested.
- Do not read DATABASE_URL, STRIPE_*, credentials, API keys, or secret environment variables in application code. The vendored NabuFlow runtime SDK is the only database path.
- Bind the HTTP server to 0.0.0.0 and Number(process.env.PORT ?? "8080").
- GET /healthz must return 200 without touching a database or any external service.
- package.json scripts are exactly build="tsc" and start="node dist/src/index.js". Set TypeScript rootDir to "." so the source-owned nabuflow module and src/ compile together. Declare every dependency normally; the trusted Pantry resolves and provisions them. Never emit npm install, npx, registry URLs, or lockfile bootstrap commands.
- The source package's Fly-compatible start script remains "node dist/src/index.js". The sealed runtime manifest is fixed at port 8080, health path /healthz, build argv ["npm","run","build"], and sealed-output start argv ["node","src/index.js"].`;

export class ZeroSealedGenerationConfigurationError extends Error {
  readonly code = "zero_sealed_generation_unavailable";

  constructor(message = "Sealed Zero generation is not enabled for this deployment") {
    super(message);
    this.name = "ZeroSealedGenerationConfigurationError";
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
  if (
    requested !== ZERO_SEALED_GENERATION_GATE_VALUE ||
    environment.TENANT_RUNTIME_PROVIDER !== "cloudflare" ||
    environment.CLOUDFLARE_RUNTIME_DEPLOYMENT_NAMESPACE !== ZERO_SEALED_DEPLOYMENT_NAMESPACE
  ) {
    throw new ZeroSealedGenerationConfigurationError();
  }
  return "cloudflare-sealed-staging-v1";
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

function dependencyPlan(pkg: PackageJson): ZeroGeneratedDependencyPlan {
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
    target: "cloudflare-sealed-staging-v1",
    intents: [...intents.values()].sort((left, right) => {
      const a = `${left.ecosystem}:${left.name}\0${left.selector}`;
      const b = `${right.ecosystem}:${right.name}\0${right.selector}`;
      return a < b ? -1 : a > b ? 1 : 0;
    }),
  });
}

export interface PreparedZeroSealedNodeSource {
  files: BuilderFile[];
  dependencyPlan: ZeroGeneratedDependencyPlan;
  manifest: RuntimeManifestContract;
}

export function prepareZeroSealedNodeSource(input: {
  files: readonly BuilderFile[];
  manifestRevision: string;
  /** Product generator paths run the canonical async eligibility scanner next. */
  skipEligibilityPrecheck?: boolean;
}): PreparedZeroSealedNodeSource {
  const byPath = new Map(input.files.map((file) => [file.path, { ...file }]));
  const packageFile = byPath.get("package.json");
  const entry = byPath.get("src/index.ts");
  const typeScriptConfigFile = byPath.get("tsconfig.json");
  if (packageFile === undefined || entry === undefined || typeScriptConfigFile === undefined) {
    throw new Error(
      "Sealed Node generation requires package.json, tsconfig.json, and src/index.ts",
    );
  }
  let pkg: PackageJson;
  try {
    pkg = JSON.parse(packageFile.content) as PackageJson;
  } catch {
    throw new Error("Sealed Node package.json is invalid");
  }
  if (pkg.scripts?.build !== "tsc" || pkg.scripts?.start !== "node dist/src/index.js") {
    throw new Error("Sealed Node scripts do not match the runtime manifest argv");
  }
  let typeScriptConfig: TypeScriptConfig;
  try {
    typeScriptConfig = JSON.parse(typeScriptConfigFile.content) as TypeScriptConfig;
  } catch {
    throw new Error("Sealed Node tsconfig.json is invalid");
  }
  if (
    typeScriptConfig.compilerOptions?.rootDir !== "." ||
    typeScriptConfig.compilerOptions?.outDir !== "dist"
  ) {
    throw new Error("Sealed Node TypeScript output must use rootDir=. and outDir=dist");
  }
  if (
    !entry.content.includes('"0.0.0.0"') ||
    !entry.content.includes("process.env.PORT") ||
    !entry.content.includes(ZERO_SEALED_HEALTH_PATH) ||
    !entry.content.includes("nabuflow/runtime") ||
    entry.content.includes(".nabuflow/runtime")
  ) {
    throw new Error("Sealed Node entrypoint is missing SDK, bind, port, or health requirements");
  }
  if (input.skipEligibilityPrecheck !== true) {
    for (const file of byPath.values()) {
      if (SECRET_ENV_PATTERN.test(file.content) || INSTALL_OR_REGISTRY_PATTERN.test(file.content)) {
        throw new Error(
          `Sealed Node source failed credential or dependency-egress scan: ${file.path}`,
        );
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
  return {
    files: [...byPath.values()].sort((left, right) => left.path.localeCompare(right.path)),
    dependencyPlan: dependencyPlan(pkg),
    manifest: makeZeroSealedNodeManifest(input.manifestRevision),
  };
}

export function isZeroSealedGenerationTarget(
  target: ZeroGenerationTarget,
): target is "cloudflare-sealed-staging-v1" {
  return target === "cloudflare-sealed-staging-v1";
}
