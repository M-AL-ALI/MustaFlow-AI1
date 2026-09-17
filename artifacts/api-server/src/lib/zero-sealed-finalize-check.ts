import type { BuilderFile } from "./builder";
import type {
  ZeroGenerationTarget,
  ZeroSealedGenerationTarget,
} from "@workspace/tenant-runtime-contracts";
import type { CheckSpec } from "./check-profiles";
import { ZERO_SEALED_BROWSER_REQUEST_GUIDANCE } from "./zero-sealed-browser-guidance";
import {
  ZeroSealedSourceContractError,
  isZeroSealedGenerationTarget,
  prepareZeroSealedNodeSource,
  type ZeroSealedSourceContractReason,
} from "./zero-sealed-generation";
import {
  ZeroCapabilityGapError,
  assertZeroGeneratedEligibility,
  inferZeroDeclaredCapabilities,
} from "./zero-capability-eligibility";

export interface ZeroSealedFinalizeCheckResult {
  passed: boolean;
  code: string;
  reasonCodes: readonly string[];
  message: string;
}

export const ZERO_SEALED_SOURCE_CHECK_ID = "zero-sealed-source-contract";

/** Keep the production source gate in every automatic and requested check pass. */
export function withZeroSealedSourceCheck(
  checks: CheckSpec[],
  target: ZeroGenerationTarget | undefined,
): CheckSpec[] {
  if (!isZeroSealedGenerationTarget(target)) return checks;
  return [
    {
      id: ZERO_SEALED_SOURCE_CHECK_ID,
      label: "Sealed source contract",
      argv: ["__inprocess__", ZERO_SEALED_SOURCE_CHECK_ID],
      runner: "inprocess",
      required: true,
      timeoutMs: 30_000,
    },
    ...checks.filter((check) => check.id !== ZERO_SEALED_SOURCE_CHECK_ID),
  ];
}

const SEALED_SOURCE_REPAIR_GUIDANCE: Readonly<Record<ZeroSealedSourceContractReason, string>> =
  Object.freeze({
    required_files: "create package.json, tsconfig.json, and src/index.ts before finalizing",
    package_json: "make package.json valid JSON",
    runtime_scripts:
      'set package.json scripts.build to "tsc" and scripts.start to "node dist/src/index.js"',
    typescript_config: "make tsconfig.json valid JSON",
    typescript_output_layout:
      'set tsconfig.json compilerOptions.rootDir to "." and compilerOptions.outDir to "dist"',
    typescript_module_specifier:
      'when TypeScript uses NodeNext, use emitted .js module paths for relative imports/exports (for example "../nabuflow/runtime/index.js"). Check retained starter files as well as new files. Migrate browser/bundler-only imports to compiler-emitted modules; do not just rename CSS imports or discard requested screens and behavior',
    sdk_import:
      'use valid TypeScript with static named or namespace imports of createNabuFlowDatabase/createNabuFlowPayments from the canonical runtime index in the application module that uses them: "../nabuflow/runtime/index.js" in src/index.ts or src/db.ts, "../../nabuflow/runtime/index.js" in src/data/db.ts; do not use provider clients, hidden SDK paths, unresolved imports, or shadowed factory bindings',
    network_bind: 'bind the HTTP server explicitly with app.listen(port, "0.0.0.0", callback)',
    runtime_port: 'derive the port with Number(process.env.PORT ?? "8080")',
    health_route:
      "serve GET /healthz with HTTP 200 without touching a database or external service",
    runtime_asset_dependency:
      "serve assets from compiler-emitted modules; remove express.static and sendFile dependencies on source-only files",
    credential_or_dependency_egress:
      "remove .env files (including .env.example), credential environment reads, tenant install commands, registry URLs, and arbitrary server-side fetches",
  });

export function describeZeroSealedSourceRepairs(reasonCodes: readonly string[]): string {
  return reasonCodes
    .map((reason) =>
      Object.hasOwn(SEALED_SOURCE_REPAIR_GUIDANCE, reason)
        ? SEALED_SOURCE_REPAIR_GUIDANCE[reason as ZeroSealedSourceContractReason]
        : `resolve ${reason}`,
    )
    .join("; ");
}

export function describeZeroCapabilityRepairs(reasonCodes: readonly string[]): string {
  return reasonCodes
    .map((reason) =>
      reason === "credential_assumption"
        ? "remove application environment reads other than process.env.PORT, including NODE_ENV and import.meta.env.MODE; use explicit non-secret defaults, not bracket access or aliases. Keep requested database and payment behavior through the NabuFlow runtime SDK; do not replace persistence with mock data or embed credentials"
        : reason === "arbitrary_runtime_fetch"
          ? ZERO_SEALED_BROWSER_REQUEST_GUIDANCE
          : `resolve ${reason} using supported runtime capabilities; preserve the user's requirements and report an unavailable capability instead of silently dropping it`,
    )
    .join("; ");
}

/** Keep actionable guidance ahead of any diagnostic text the observation cap can remove. */
export function formatZeroSealedFinalizeFailure(
  check: ZeroSealedFinalizeCheckResult,
  otherFailures: readonly string[],
): string {
  const repairs =
    check.code === "zero_sealed_source_contract_error"
      ? describeZeroSealedSourceRepairs(check.reasonCodes)
      : check.code === "zero_capability_gap"
        ? describeZeroCapabilityRepairs(check.reasonCodes)
        : check.message;
  return [
    "BLOCKED: cannot finalize.",
    `Required repairs: ${repairs}`,
    "Fix the failures and call finalize again.",
    `- zero-sealed-source-contract: ${check.message}`,
    ...otherFailures,
  ].join("\n");
}

/** Run the job wrapper's sealed-source contract while Zero can still repair it. */
export async function checkZeroSealedFinalizeContract(input: {
  files: readonly BuilderFile[];
  target?: ZeroSealedGenerationTarget;
  manifestRevision?: string;
}): Promise<ZeroSealedFinalizeCheckResult> {
  try {
    const prepared = prepareZeroSealedNodeSource({
      files: input.files,
      target: input.target,
      ...(input.manifestRevision === undefined ? {} : { manifestRevision: input.manifestRevision }),
      skipEligibilityPrecheck: true,
    });
    await assertZeroGeneratedEligibility({
      files: prepared.files,
      dependencyPlan: prepared.dependencyPlan,
      runtimeManifest: prepared.manifest,
      declaredCapabilities: inferZeroDeclaredCapabilities(prepared.files),
      pantryClosureVerified: false,
      dependencyOutputAttested: false,
      stage: "source",
    });
    return {
      passed: true,
      code: "zero_sealed_source_ready",
      reasonCodes: [],
      message: "sealed source contract passed",
    };
  } catch (error) {
    if (error instanceof ZeroSealedSourceContractError) {
      const repairs = describeZeroSealedSourceRepairs(error.reasons);
      return {
        passed: false,
        code: error.code,
        reasonCodes: error.reasons,
        message: `${error.code}: ${error.reasons.join(", ")}${error.path ? ` (${error.path})` : ""}. Required repairs: ${repairs}`,
      };
    }
    if (error instanceof ZeroCapabilityGapError) {
      const reasonCodes = [...new Set(error.result.reasons.map((reason) => reason.code))].sort();
      const affectedFiles = [
        ...new Set(
          error.result.reasons.map(
            (reason) => `${reason.code}${reason.path ? ` (${reason.path})` : ""}`,
          ),
        ),
      ].sort();
      return {
        passed: false,
        code: error.code,
        reasonCodes,
        message: `${error.code}: ${reasonCodes.join(", ")}. Required repairs: ${describeZeroCapabilityRepairs(reasonCodes)}. Affected files: ${affectedFiles.join("; ")}`,
      };
    }
    const errorClass = error instanceof Error ? error.name : "UnknownError";
    return {
      passed: false,
      code: "zero_sealed_finalize_internal",
      reasonCodes: [errorClass],
      message: `zero_sealed_finalize_internal: ${errorClass}`,
    };
  }
}
