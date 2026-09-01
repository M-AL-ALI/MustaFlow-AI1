const LEGACY_FLY_MACHINE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;

export type LegacyFlyRetirementRetentionReason =
  | "legacy_pointer_malformed"
  | "provider_observation_unavailable"
  | "provider_response_invalid"
  | "machine_identity_mismatch"
  | "project_identity_mismatch"
  | "contradictory_identity_marker"
  | "storage_ownership_ambiguous"
  | "provider_delete_unavailable"
  | "absence_unverified";

export type LegacyFlyRuntimeReconciliation =
  | {
      state: "verified_absent";
      proof: "initial_get_404" | "delete_then_get_404";
    }
  | {
      state: "retained";
      reason: LegacyFlyRetirementRetentionReason;
      retryable: boolean;
    };

export type LegacyFlyRetirementRequest = (input: {
  machineId: string;
  method: "GET" | "DELETE";
}) => Promise<Pick<Response, "json" | "status">>;

const requestThroughContainer: LegacyFlyRetirementRequest = async (input) => {
  const { requestLegacyFlyMachineForRetirement } = await import("./container");
  return requestLegacyFlyMachineForRetirement(input);
};

const retained = (
  reason: LegacyFlyRetirementRetentionReason,
  retryable: boolean,
): LegacyFlyRuntimeReconciliation => ({ state: "retained", reason, retryable });

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizedMarker(key: string): string {
  return key.replace(/[^A-Za-z0-9]/gu, "").toLowerCase();
}

function markerContradictsProject(
  document: Record<string, unknown>,
  expectedProjectId: string,
  expectedMachineId: string,
  expectedName: string,
): boolean {
  const pending: unknown[] = [document];
  while (pending.length > 0) {
    const value = pending.pop();
    if (Array.isArray(value)) {
      pending.push(...value);
      continue;
    }
    if (!isRecord(value)) continue;
    for (const [key, child] of Object.entries(value)) {
      const marker = normalizedMarker(key);
      if (marker.endsWith("projectid") && String(child) !== expectedProjectId) return true;
      if (marker === "projectname" && child !== expectedName) return true;
      if (marker === "machineid" && child !== expectedMachineId) return true;
      pending.push(child);
    }
  }
  return false;
}

function hasAmbiguousStorage(document: Record<string, unknown>): boolean {
  const config = document.config;
  if (!isRecord(config) || !Array.isArray(config.mounts) || config.mounts.length !== 0) return true;

  const pending: Array<{ path: string; value: unknown }> = [{ path: "", value: document }];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) continue;
    if (Array.isArray(current.value)) {
      current.value.forEach((value, index) =>
        pending.push({ path: `${current.path}.${index}`, value }),
      );
      continue;
    }
    if (!isRecord(current.value)) continue;
    for (const [key, value] of Object.entries(current.value)) {
      const path = current.path ? `${current.path}.${key}` : key;
      const marker = normalizedMarker(key);
      if ((marker.includes("mount") || marker.includes("volume")) && path !== "config.mounts") {
        return true;
      }
      pending.push({ path, value });
    }
  }
  return false;
}

function validateObservedMachine(input: {
  document: unknown;
  machineId: string;
  projectId: number;
}): LegacyFlyRetirementRetentionReason | null {
  if (!isRecord(input.document)) return "provider_response_invalid";
  const expectedProjectId = String(input.projectId);
  const expectedName = `project-${expectedProjectId}`;
  if (input.document.id !== input.machineId) return "machine_identity_mismatch";
  if (input.document.name !== expectedName) return "project_identity_mismatch";

  const config = input.document.config;
  if (!isRecord(config) || !isRecord(config.env)) return "provider_response_invalid";
  if (config.env.PROJECT_ID !== expectedProjectId) return "project_identity_mismatch";
  if (markerContradictsProject(input.document, expectedProjectId, input.machineId, expectedName)) {
    return "contradictory_identity_marker";
  }
  if (hasAmbiguousStorage(input.document)) return "storage_ownership_ambiguous";
  return null;
}

async function requestSafely(
  request: LegacyFlyRetirementRequest,
  input: { machineId: string; method: "GET" | "DELETE" },
): Promise<Pick<Response, "json" | "status"> | null> {
  try {
    return await request(input);
  } catch {
    return null;
  }
}

/**
 * Reconcile one historical Fly machine pointer without involving the current
 * tenant-runtime provider. A pointer is cleared only after authoritative 404
 * evidence, and no provider document or identifier is returned to callers.
 */
export async function reconcileLegacyFlyRuntime(
  input: { machineId: string; projectId: number },
  request: LegacyFlyRetirementRequest = requestThroughContainer,
): Promise<LegacyFlyRuntimeReconciliation> {
  if (!Number.isSafeInteger(input.projectId) || input.projectId <= 0) {
    return retained("legacy_pointer_malformed", false);
  }
  if (!LEGACY_FLY_MACHINE_ID.test(input.machineId)) {
    return retained("legacy_pointer_malformed", false);
  }

  const observation = await requestSafely(request, { machineId: input.machineId, method: "GET" });
  if (!observation) return retained("provider_observation_unavailable", true);
  if (observation.status === 404) {
    return { state: "verified_absent", proof: "initial_get_404" };
  }
  if (observation.status !== 200) return retained("provider_observation_unavailable", true);

  let document: unknown;
  try {
    document = await observation.json();
  } catch {
    return retained("provider_response_invalid", true);
  }
  const refusal = validateObservedMachine({
    document,
    machineId: input.machineId,
    projectId: input.projectId,
  });
  if (refusal) return retained(refusal, false);

  const deletion = await requestSafely(request, { machineId: input.machineId, method: "DELETE" });
  if (!deletion || (deletion.status !== 404 && (deletion.status < 200 || deletion.status >= 300))) {
    return retained("provider_delete_unavailable", true);
  }

  const verification = await requestSafely(request, {
    machineId: input.machineId,
    method: "GET",
  });
  if (verification?.status !== 404) return retained("absence_unverified", true);
  return { state: "verified_absent", proof: "delete_then_get_404" };
}
