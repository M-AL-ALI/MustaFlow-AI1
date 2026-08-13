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
      return {
        passed: false,
        code: error.code,
        reasonCodes: error.reasons,
        message: `${error.code}: ${error.reasons.join(", ")}${error.path ? ` (${error.path})` : ""}`,
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
