import type { BuilderFile } from "./builder";
import {
  ZeroSealedSourceContractError,
  prepareZeroSealedNodeSource,
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

const SEALED_SOURCE_REPAIR_GUIDANCE: Readonly<Record<string, string>> = Object.freeze({
  required_files: "create package.json, tsconfig.json, and src/index.ts before finalizing",
  package_json: "make package.json valid JSON",
  runtime_scripts:
    'set package.json scripts.build to "tsc" and scripts.start to "node dist/src/index.js"',
  typescript_config: "make tsconfig.json valid JSON",
  typescript_output_layout:
    'set tsconfig.json compilerOptions.rootDir to "." and compilerOptions.outDir to "dist"',
  sdk_import:
    'import and use createNabuFlowDatabase/createNabuFlowPayments as needed from "../nabuflow/runtime/index" in src/index.ts; do not use provider clients',
  network_bind: 'bind the HTTP server explicitly with app.listen(port, "0.0.0.0", callback)',
  runtime_port: 'derive the port with Number(process.env.PORT ?? "8080")',
  health_route: "serve GET /healthz with HTTP 200 without touching a database or external service",
  credential_or_dependency_egress:
    "remove .env files (including .env.example), credential environment reads, tenant install commands, registry URLs, and arbitrary server-side fetches",
});

export function describeZeroSealedSourceRepairs(reasonCodes: readonly string[]): string {
  return reasonCodes
    .map((reason) => SEALED_SOURCE_REPAIR_GUIDANCE[reason] ?? `resolve ${reason}`)
    .join("; ");
}

/** Run the job wrapper's sealed-source contract while Zero can still repair it. */
export async function checkZeroSealedFinalizeContract(input: {
  files: readonly BuilderFile[];
  manifestRevision: string;
}): Promise<ZeroSealedFinalizeCheckResult> {
  try {
    const prepared = prepareZeroSealedNodeSource({
      files: input.files,
      manifestRevision: input.manifestRevision,
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
      return {
        passed: false,
        code: error.code,
        reasonCodes,
        message: `${error.code}: ${reasonCodes.join(", ")}`,
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
