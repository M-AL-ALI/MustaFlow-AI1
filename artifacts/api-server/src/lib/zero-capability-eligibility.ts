import { existsSync, promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ZERO_ELIGIBILITY_REASON_CODES,
  deriveZeroEligibilityIdentity,
  deriveZeroIntegrationEligibilityIdentity,
  sha256Hex,
  zeroCapabilityEligibilityMetadataContractSchema,
  zeroEligibilityEnvelopeSchema,
  zeroSealedNodeRuntimeManifestSchema,
  type RuntimeManifestContract,
  type ZeroCapabilityEligibilityMetadata,
  type ZeroEligibilityReason,
  type ZeroEligibilityResult,
  type ZeroGeneratedDependencyPlan,
} from "@workspace/tenant-runtime-contracts";
import type { BuilderFile } from "./builder";

export const ZERO_ELIGIBILITY_METADATA_FILENAME = "eligibility.json" as const;
export const ZERO_ELIGIBILITY_ASSET_DIRECTORY = "zero-eligibility-assets" as const;

const RAW_DATABASE_PACKAGES = new Set([
  "@libsql/client",
  "@neondatabase/serverless",
  "better-sqlite3",
  "firebase",
  "mongodb",
  "mysql2",
  "pg",
  "postgres",
  "redis",
  "sqlite3",
  "@supabase/supabase-js",
]);
const RAW_PAYMENT_PACKAGES = new Set(["@paddle/paddle-node-sdk", "stripe", "whop"]);
const RUNTIME_FETCH_PATTERN =
  /(?:\bfetch\s*\(|\baxios\s*\(|\bgot\s*\(|\brequest\s*\(|\bnew\s+(?:WebSocket|EventSource)\s*\(|\bhttps?\.(?:request|get)\s*\()/u;
const PACKAGE_INSTALL_PATTERN =
  /(?:\bnpx\b|\b(?:npm|pnpm|yarn|bun)\s+(?:i|install|add|dlx)\b|registry\.npmjs\.org)/u;
const ENV_READ_PATTERN = /(?:process\.env|import\.meta\.env)\.([A-Z][A-Z0-9_]*)/gu;
const SDK_PATH_PREFIX = "nabuflow/runtime/";

export class ZeroEligibilityInventoryError extends Error {
  readonly code = "zero_eligibility_unclassified";
  readonly retryable = false;
  readonly reasons: readonly ZeroEligibilityReason[];

  constructor(readonly entries: readonly string[]) {
    super(`Zero eligibility inventory is incomplete: ${entries.join(", ")}`);
    this.name = "ZeroEligibilityInventoryError";
    this.reasons = entries.map((entry) => ({ code: "unclassified_integration", path: entry }));
  }
}

export class ZeroCapabilityGapError extends Error {
  readonly code = "zero_capability_gap";
  readonly retryable = false;

  constructor(readonly result: Extract<ZeroEligibilityResult, { ok: false }>) {
    super(
      `Generated application has unsupported sealed capabilities: ${result.reasons
        .map((reason) => reason.code)
        .join(", ")}`,
    );
    this.name = "ZeroCapabilityGapError";
  }
}

export function resolveZeroEligibilityRepositoryRoot(
  moduleUrl = import.meta.url,
  workingDirectory = process.cwd(),
): string {
  const candidates: string[] = [];
  for (const start of [path.dirname(fileURLToPath(moduleUrl)), workingDirectory]) {
    let candidate = path.resolve(start);
    for (let depth = 0; depth <= 8; depth += 1) {
      if (!candidates.includes(candidate)) candidates.push(candidate);
      const parent = path.dirname(candidate);
      if (parent === candidate) break;
      candidate = parent;
    }
  }
  for (const candidate of candidates) {
    for (const root of [candidate, path.join(candidate, ZERO_ELIGIBILITY_ASSET_DIRECTORY)]) {
      if (existsSync(path.join(root, "blueprints")) && existsSync(path.join(root, "skills"))) {
        return root;
      }
    }
  }
  return path.resolve(workingDirectory);
}

function repositoryRoot(): string {
  return resolveZeroEligibilityRepositoryRoot();
}

async function entriesWithMarker(
  root: string,
  marker: string,
  kind: "blueprint" | "skill",
): Promise<string[]> {
  let entries;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    throw new ZeroEligibilityInventoryError([`${kind}:inventory_unavailable`]);
  }
  const present: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === "_drafts") continue;
    try {
      await fs.access(path.join(root, entry.name, marker));
      present.push(entry.name);
    } catch {
      // A directory without the authoritative marker is not an integration.
    }
  }
  return present.sort();
}

async function readMetadata(
  root: string,
  kind: "blueprint" | "skill",
  id: string,
): Promise<ZeroCapabilityEligibilityMetadata> {
  const metadataPath = path.join(root, id, ZERO_ELIGIBILITY_METADATA_FILENAME);
  let text: string;
  try {
    text = await fs.readFile(metadataPath, "utf8");
  } catch {
    throw new ZeroEligibilityInventoryError([`${kind}:${id}`]);
  }
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    throw new ZeroEligibilityInventoryError([`${kind}:${id}:invalid_json`]);
  }
  const parsed = zeroCapabilityEligibilityMetadataContractSchema.safeParse(value);
  if (!parsed.success || parsed.data.kind !== kind || parsed.data.id !== id) {
    throw new ZeroEligibilityInventoryError([`${kind}:${id}:invalid_contract`]);
  }
  return parsed.data;
}

export interface ZeroEligibilityInventory {
  blueprints: ReadonlyMap<string, ZeroCapabilityEligibilityMetadata>;
  skills: ReadonlyMap<string, ZeroCapabilityEligibilityMetadata>;
}

/**
 * Exhaustive inventory loader. A new blueprint or approved skill cannot enter
 * CI without a valid machine-readable sealed-runtime classification.
 */
export async function loadZeroEligibilityInventory(
  root = repositoryRoot(),
): Promise<ZeroEligibilityInventory> {
  const blueprintsRoot = path.join(root, "blueprints");
  const skillsRoot = path.join(root, "skills");
  const [blueprintIds, skillIds] = await Promise.all([
    entriesWithMarker(blueprintsRoot, "blueprint.json", "blueprint"),
    entriesWithMarker(skillsRoot, "SKILL.md", "skill"),
  ]);
  const missing: string[] = [];
  const blueprints = new Map<string, ZeroCapabilityEligibilityMetadata>();
  const skills = new Map<string, ZeroCapabilityEligibilityMetadata>();
  for (const [kind, ids, sourceRoot, destination] of [
    ["blueprint", blueprintIds, blueprintsRoot, blueprints],
    ["skill", skillIds, skillsRoot, skills],
  ] as const) {
    for (const id of ids) {
      try {
        destination.set(id, await readMetadata(sourceRoot, kind, id));
      } catch (error) {
        if (error instanceof ZeroEligibilityInventoryError) {
          missing.push(...error.entries);
          continue;
        }
        throw error;
      }
    }
  }
  if (missing.length > 0) throw new ZeroEligibilityInventoryError(missing.sort());
  return { blueprints, skills };
}

export async function resolveZeroIntegrationEligibility(
  kind: "blueprint" | "skill",
  id: string,
  root = repositoryRoot(),
): Promise<ZeroCapabilityEligibilityMetadata> {
  const inventory = await loadZeroEligibilityInventory(root);
  const metadata = (kind === "blueprint" ? inventory.blueprints : inventory.skills).get(id);
  if (metadata === undefined) throw new ZeroEligibilityInventoryError([`${kind}:${id}`]);
  return metadata;
}

export async function resolveZeroIntegrationEligibilityOutcome(
  kind: "blueprint" | "skill",
  id: string,
  root = repositoryRoot(),
): Promise<ZeroEligibilityResult> {
  const metadata = await resolveZeroIntegrationEligibility(kind, id, root);
  const identitySha256 = await deriveZeroIntegrationEligibilityIdentity(metadata);
  if (metadata.cloudflare.status === "ineligible") {
    return {
      ok: false,
      code: "zero_capability_gap",
      retryable: false,
      identitySha256,
      reasons: [...metadata.cloudflare.reasons],
    };
  }
  return {
    ok: true,
    code: "zero_generation_eligible",
    identitySha256,
    capabilities: [...metadata.cloudflare.capabilities],
  };
}

function addReason(
  reasons: ZeroEligibilityReason[],
  code: ZeroEligibilityReason["code"],
  filePath?: string,
): void {
  const reason = filePath === undefined ? { code } : { code, path: filePath };
  if (!reasons.some((item) => item.code === reason.code && item.path === reason.path)) {
    reasons.push(reason);
  }
}

function packageDependencies(file: BuilderFile | undefined): Set<string> | null {
  if (file === undefined) return null;
  try {
    const parsed = JSON.parse(file.content) as {
      dependencies?: Record<string, unknown>;
      devDependencies?: Record<string, unknown>;
    };
    const names = new Set<string>();
    for (const group of [parsed.dependencies ?? {}, parsed.devDependencies ?? {}]) {
      for (const [name, value] of Object.entries(group)) {
        if (typeof value !== "string" || value.length === 0) return null;
        names.add(name);
      }
    }
    return names;
  } catch {
    return null;
  }
}

function referencesPackage(source: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(
    `(?:from\\s+["']${escaped}["']|require\\(\\s*["']${escaped}["']\\s*\\)|import\\(\\s*["']${escaped}["']\\s*\\))`,
    "u",
  ).test(source);
}

export interface EvaluateZeroGeneratedEligibilityInput {
  files: readonly BuilderFile[];
  dependencyPlan: ZeroGeneratedDependencyPlan;
  runtimeManifest: RuntimeManifestContract;
  declaredCapabilities: readonly ("database" | "stripe-payments")[];
  pantryClosureVerified: boolean;
  dependencyOutputAttested: boolean;
  toolchain?: string;
  stage?: "source" | "attested-output";
}

export function inferZeroDeclaredCapabilities(
  files: readonly BuilderFile[],
): Array<"database" | "stripe-payments"> {
  let database = false;
  let payments = false;
  for (const file of files) {
    if (file.path.startsWith(SDK_PATH_PREFIX)) continue;
    database ||= file.content.includes("createNabuFlowDatabase");
    payments ||= file.content.includes("createNabuFlowPayments");
  }
  return [
    ...(database ? (["database"] as const) : []),
    ...(payments ? (["stripe-payments"] as const) : []),
  ];
}

/**
 * Exhaustive, content-derived sealed-runtime scan. It is deliberately based on
 * dynamic Pantry closure/attestation facts rather than a package-name allowlist;
 * package sets below are deny signatures for credential/network bypasses only.
 */
export async function evaluateZeroGeneratedEligibility(
  input: EvaluateZeroGeneratedEligibilityInput,
): Promise<ZeroEligibilityResult> {
  const reasons: ZeroEligibilityReason[] = [];
  const toolchain = input.toolchain ?? "node-api";
  if (toolchain !== "node-api") addReason(reasons, "unsupported_toolchain");

  const byPath = new Map(input.files.map((file) => [file.path, file]));
  const packageNames = packageDependencies(byPath.get("package.json"));
  const plannedNames = new Set(input.dependencyPlan.intents.map((intent) => intent.name));
  if (packageNames === null) {
    addReason(reasons, "undeclared_dependency", "package.json");
  } else {
    for (const name of new Set([...packageNames, ...plannedNames])) {
      if (!packageNames.has(name) || !plannedNames.has(name)) {
        addReason(reasons, "undeclared_dependency", "package.json");
        break;
      }
    }
    for (const name of packageNames) {
      if (RAW_DATABASE_PACKAGES.has(name))
        addReason(reasons, "raw_database_client", "package.json");
      if (RAW_PAYMENT_PACKAGES.has(name)) addReason(reasons, "raw_payment_client", "package.json");
    }
  }
  if ((input.stage ?? "attested-output") === "attested-output") {
    if (!input.pantryClosureVerified) addReason(reasons, "pantry_unresolvable_dependency");
    if (!input.dependencyOutputAttested) addReason(reasons, "dependency_output_unattested");
  }

  let databaseUsed = false;
  let paymentsUsed = false;
  for (const file of input.files) {
    if (file.path.startsWith(SDK_PATH_PREFIX)) continue;
    if (file.content.includes("createNabuFlowDatabase")) databaseUsed = true;
    if (file.content.includes("createNabuFlowPayments")) paymentsUsed = true;
    ENV_READ_PATTERN.lastIndex = 0;
    for (const match of file.content.matchAll(ENV_READ_PATTERN)) {
      if (match[1] !== "PORT") addReason(reasons, "credential_assumption", file.path);
    }
    if (RUNTIME_FETCH_PATTERN.test(file.content)) {
      addReason(reasons, "arbitrary_runtime_fetch", file.path);
    }
    if (PACKAGE_INSTALL_PATTERN.test(file.content)) {
      addReason(reasons, "tenant_package_install", file.path);
    }
    for (const name of RAW_DATABASE_PACKAGES) {
      if (referencesPackage(file.content, name)) {
        addReason(reasons, "raw_database_client", file.path);
      }
    }
    for (const name of RAW_PAYMENT_PACKAGES) {
      if (referencesPackage(file.content, name)) {
        addReason(reasons, "raw_payment_client", file.path);
      }
    }
  }

  const declared = new Set(input.declaredCapabilities);
  if (databaseUsed && !declared.has("database")) addReason(reasons, "undeclared_capability");
  if (paymentsUsed && !declared.has("stripe-payments")) addReason(reasons, "undeclared_capability");
  try {
    zeroSealedNodeRuntimeManifestSchema.parse(input.runtimeManifest);
  } catch {
    addReason(reasons, "port_manifest_incompatible");
  }

  const files = await Promise.all(
    input.files.map(async (file) => ({ path: file.path, sha256: await sha256Hex(file.content) })),
  );
  files.sort((left, right) => left.path.localeCompare(right.path));
  const envelope = zeroEligibilityEnvelopeSchema.parse({
    target: "cloudflare-sealed-staging-v1",
    toolchain,
    files,
    dependencyPlan: input.dependencyPlan,
    runtimeManifest: input.runtimeManifest,
    declaredCapabilities: [...input.declaredCapabilities].sort(),
    pantryClosureVerified: input.pantryClosureVerified,
    dependencyOutputAttested: input.dependencyOutputAttested,
  });
  const identitySha256 = await deriveZeroEligibilityIdentity(envelope);
  reasons.sort((left, right) => {
    const leftIndex = ZERO_ELIGIBILITY_REASON_CODES.indexOf(left.code);
    const rightIndex = ZERO_ELIGIBILITY_REASON_CODES.indexOf(right.code);
    return leftIndex - rightIndex || (left.path ?? "").localeCompare(right.path ?? "");
  });
  if (reasons.length > 0) {
    return { ok: false, code: "zero_capability_gap", retryable: false, identitySha256, reasons };
  }
  return {
    ok: true,
    code: "zero_generation_eligible",
    identitySha256,
    capabilities: [...input.declaredCapabilities].sort(),
  };
}

export async function assertZeroGeneratedEligibility(
  input: EvaluateZeroGeneratedEligibilityInput,
): Promise<Extract<ZeroEligibilityResult, { ok: true }>> {
  const result = await evaluateZeroGeneratedEligibility(input);
  if (!result.ok) throw new ZeroCapabilityGapError(result);
  return result;
}
