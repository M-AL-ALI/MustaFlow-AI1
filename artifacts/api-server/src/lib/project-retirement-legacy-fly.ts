const LEGACY_FLY_MACHINE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const LEGACY_FLY_VOLUME_ID = /^vol_[A-Za-z0-9_-]{1,128}$/u;
const MAX_VOLUME_CATALOG_ROWS = 1_000;
const MAX_MACHINE_CATALOG_ROWS = 1_000;
const MAX_PROVIDER_BODY_BYTES = 1_048_576;
const MAX_PROVIDER_NODES = 16_384;
const MAX_PROVIDER_DEPTH = 32;
const MACHINE_LEASE_TTL_SECONDS = 300;
const MIN_MUTATION_LEASE_MS = 30_000;
const LEGACY_FLY_INSTANCE_ID = /^[0-9A-HJKMNP-TV-Z]{26}$/iu;

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
      proof:
        | "initial_get_404"
        | "delete_then_get_404"
        | "initial_destroyed_tombstone_active_catalog_absent"
        | "delete_then_destroyed_tombstone_active_catalog_absent";
    }
  | {
      state: "retained";
      reason: LegacyFlyRetirementRetentionReason;
      retryable: boolean;
    };

export type LegacyFlyRetirementRequest = (
  input:
    | { machineId: string; method: "GET"; resource?: never; leaseNonce?: string }
    | { machineId: string; method: "DELETE"; resource?: never; leaseNonce: string }
    | { resource: "stop"; machineId: string; method: "POST"; leaseNonce: string }
    | {
        resource: "wait";
        machineId: string;
        method: "GET";
        instanceId: string;
        leaseNonce: string;
      }
    | { resource: "volumes"; method: "GET"; machineId?: never }
    | { resource: "machines"; method: "GET"; machineId?: never }
    | {
        resource: "lease";
        machineId: string;
        method: "POST";
        description: string;
        ttl: number;
      }
    | { resource: "lease"; machineId: string; method: "DELETE"; leaseNonce: string },
) => Promise<Response>;

const requestThroughContainer: LegacyFlyRetirementRequest = async (input) => {
  const { requestLegacyFlyMachineForRetirement } = await import("./container");
  return requestLegacyFlyMachineForRetirement(input);
};

const retained = (
  reason: LegacyFlyRetirementRetentionReason,
  retryable: boolean,
): Extract<LegacyFlyRuntimeReconciliation, { state: "retained" }> => ({
  state: "retained",
  reason,
  retryable,
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizedMarker(key: string): string {
  return key.replace(/[^A-Za-z0-9]/gu, "").toLowerCase();
}

type DocumentPath = Array<string | number>;

/** Bound all document walks, including the walk preceding fingerprint creation. */
function walkDocument(
  document: unknown,
  visit: (value: unknown, path: DocumentPath) => void,
): void {
  const pending = [{ value: document, path: [] as DocumentPath }];
  let nodes = 1;
  while (pending.length > 0) {
    const current = pending.pop()!;
    visit(current.value, current.path);
    const entries = Array.isArray(current.value)
      ? current.value.map((value, index) => [index, value] as const)
      : isRecord(current.value)
        ? Object.entries(current.value)
        : [];
    for (const [key, value] of entries) {
      if (++nodes > MAX_PROVIDER_NODES || current.path.length >= MAX_PROVIDER_DEPTH) {
        throw new Error("Provider document exceeds traversal bounds");
      }
      pending.push({ value, path: [...current.path, key] });
    }
  }
}

/** Read decoded bytes from the stream before allocating a parsed JSON document. */
async function readBoundedJson(response: Response): Promise<unknown> {
  const contentLength = response.headers.get("content-length");
  if (
    contentLength !== null &&
    (!/^\d+$/u.test(contentLength) || Number(contentLength) > MAX_PROVIDER_BODY_BYTES)
  ) {
    throw new Error("Provider body exceeds bounds");
  }
  if (!response.body) throw new Error("Provider body missing");
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  let chunks = 0;
  let text = "";
  let complete = false;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) {
        complete = true;
        break;
      }
      bytes += chunk.value.byteLength;
      if (bytes > MAX_PROVIDER_BODY_BYTES || ++chunks > MAX_PROVIDER_NODES) {
        throw new Error("Provider body exceeds bounds");
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
  } finally {
    if (!complete) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  const document: unknown = JSON.parse(text);
  walkDocument(document, () => undefined);
  return document;
}

function markerContradictsProject(
  document: Record<string, unknown>,
  expectedProjectId: string,
  expectedMachineId: string,
  expectedName: string,
): boolean {
  let contradictory = false;
  walkDocument(document, (child, path) => {
    const key = path[path.length - 1];
    if (typeof key !== "string") return;
    const marker = normalizedMarker(key);
    if (marker.endsWith("projectid")) {
      // Never coerce arbitrary provider objects, including malicious toString keys.
      const projectId =
        typeof child === "string"
          ? child
          : typeof child === "number" && Number.isSafeInteger(child)
            ? String(child)
            : null;
      if (projectId !== expectedProjectId) contradictory = true;
    }
    if (marker === "projectname" && child !== expectedName) contradictory = true;
    if (marker === "machineid" && child !== expectedMachineId) contradictory = true;
  });
  return contradictory;
}

function hasAmbiguousStorage(document: Record<string, unknown>): boolean {
  const config = document.config;
  if (!isRecord(config)) return true;
  if ("mounts" in config && (!Array.isArray(config.mounts) || config.mounts.length !== 0)) {
    return true;
  }
  let ambiguous = false;
  walkDocument(document, (_value, path) => {
    const key = path[path.length - 1];
    if (typeof key !== "string") return;
    const marker = normalizedMarker(key);
    const canonicalMounts = path.length === 2 && path[0] === "config" && key === "mounts";
    if (
      (marker.includes("mount") || marker.includes("volume") || marker.includes("attach")) &&
      !canonicalMounts
    ) {
      ambiguous = true;
    }
  });
  return ambiguous;
}

function validateObservedMachine(input: {
  document: unknown;
  machineId: string;
  projectId: number;
}): LegacyFlyRetirementRetentionReason | null {
  if (!isRecord(input.document)) return "provider_response_invalid";
  const expectedProjectId = String(input.projectId);
  const expectedName = "project-" + expectedProjectId;
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
  input: Parameters<LegacyFlyRetirementRequest>[0],
): Promise<Response | null> {
  try {
    return await request(input);
  } catch {
    return null;
  }
}

function observationFingerprint(value: unknown): string {
  return JSON.stringify(value, (_key, child: unknown) =>
    isRecord(child)
      ? Object.fromEntries(
          Object.entries(child).sort(([left], [right]) => left.localeCompare(right)),
        )
      : child,
  );
}

/**
 * A stop changes state and the documented top-level lifecycle telemetry, not
 * identity, instance_id, config, image or storage. This projection is used ONLY
 * across our own acknowledged STOP; pre-lease comparisons remain exact.
 * The full document still passes ownership/storage walks before any exclusion.
 * https://fly.io/docs/machines/api/machines-resource/#machine-properties
 */
function stoppedMachineFingerprint(document: Record<string, unknown>): string | null {
  const { nonce, state, events, updated_at, checks, ...facts } = document;
  if (
    ("events" in document && (!Array.isArray(events) || !events.every(isRecord))) ||
    ("updated_at" in document &&
      (typeof updated_at !== "string" ||
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/u.test(updated_at) ||
        !Number.isFinite(Date.parse(updated_at)))) ||
    ("checks" in document &&
      !(isRecord(checks) || (Array.isArray(checks) && checks.every(isRecord))))
  ) {
    return null;
  }
  return observationFingerprint(facts);
}

async function observeMachine(
  response: Response,
  input: { machineId: string; projectId: number },
): Promise<
  | {
      state: "complete";
      fingerprint: string;
      nonce: string | undefined;
      machineState: unknown;
      instanceId: string | null;
      stopFingerprint: string | null;
      canStopWithoutAutoDestroy: boolean;
    }
  | Extract<LegacyFlyRuntimeReconciliation, { state: "retained" }>
> {
  try {
    const document = await readBoundedJson(response);
    if (!isRecord(document)) return retained("provider_response_invalid", false);
    const refusal = validateObservedMachine({ document, ...input });
    if (refusal) return retained(refusal, false);
    // Only the exact top-level nonce is lease metadata, not an ownership fact.
    const { nonce, ...machineFacts } = document;
    if ("nonce" in document && !isSafeLeaseNonce(nonce)) {
      return retained("provider_response_invalid", false);
    }
    return {
      state: "complete",
      fingerprint: observationFingerprint(machineFacts),
      nonce: typeof nonce === "string" ? nonce : undefined,
      machineState: document.state,
      instanceId:
        typeof document.instance_id === "string" &&
        LEGACY_FLY_INSTANCE_ID.test(document.instance_id)
          ? document.instance_id
          : null,
      stopFingerprint: stoppedMachineFingerprint(document),
      canStopWithoutAutoDestroy:
        isRecord(document.config) && document.config.auto_destroy === false,
    };
  } catch {
    return retained("provider_response_invalid", false);
  }
}

/** Only the exact, top-level Fly attachment fields have known semantics. */
function hasUnknownVolumeRelationship(volume: Record<string, unknown>): boolean {
  let ambiguous = false;
  walkDocument(volume, (_value, path) => {
    const key = path[path.length - 1];
    if (typeof key !== "string") return;
    if (path.length === 1 && (key === "attached_machine_id" || key === "attached_alloc_id")) {
      return;
    }
    const marker = normalizedMarker(key);
    if (
      marker.includes("attach") ||
      marker.includes("mount") ||
      marker.includes("volume") ||
      marker.includes("machine") ||
      marker.endsWith("projectid") ||
      marker.endsWith("allocid") ||
      ["hasmore", "nextcursor", "nextpage"].includes(marker)
    ) {
      ambiguous = true;
    }
  });
  return ambiguous;
}

/** Both fixed-app catalogs must be unpaginated, bounded, complete arrays. */
async function readCompleteCatalog(response: Response, maxRows: number): Promise<unknown[]> {
  if (response.status !== 200) throw new Error("Incomplete provider catalog");
  for (const name of [
    "link",
    "content-range",
    "x-next-page",
    "x-next-cursor",
    "next-cursor",
    "x-pagination-next-page",
    "x-page",
    "x-per-page",
    "x-page-size",
    "x-has-more",
  ]) {
    if (response.headers.get(name) !== null) throw new Error("Paginated provider catalog");
  }
  const body = await readBoundedJson(response);
  if (!Array.isArray(body) || body.length >= maxRows) {
    throw new Error("Incomplete provider catalog");
  }
  for (const name of ["x-total-count", "x-total"]) {
    const total = response.headers.get(name);
    if (total !== null && (!/^\d+$/u.test(total) || Number(total) !== body.length)) {
      throw new Error("Incomplete provider catalog");
    }
  }
  return body;
}

async function observeUnmountedVolumeCatalog(
  machineId: string,
  request: LegacyFlyRetirementRequest,
): Promise<
  | { state: "complete"; fingerprint: string }
  | Extract<LegacyFlyRuntimeReconciliation, { state: "retained" }>
> {
  const observation = await requestSafely(request, { resource: "volumes", method: "GET" });
  const blocked = () => retained("storage_ownership_ambiguous", false);
  if (!observation || observation.status !== 200) return blocked();
  try {
    const body = await readCompleteCatalog(observation, MAX_VOLUME_CATALOG_ROWS);
    const ids = new Set<string>();
    const volumes: Array<Record<string, unknown> & { id: string }> = [];
    for (const volume of body) {
      if (
        !isRecord(volume) ||
        typeof volume.id !== "string" ||
        !LEGACY_FLY_VOLUME_ID.test(volume.id) ||
        ids.has(volume.id) ||
        typeof volume.attached_machine_id !== "string" ||
        !LEGACY_FLY_MACHINE_ID.test(volume.attached_machine_id) ||
        volume.attached_machine_id === machineId ||
        ("attached_alloc_id" in volume && volume.attached_alloc_id !== null) ||
        hasUnknownVolumeRelationship(volume)
      ) {
        return blocked();
      }
      ids.add(volume.id);
      const storageFacts: Record<string, unknown> & { id: string } = { ...volume, id: volume.id };
      // Fly's top-level free-block counters can change without storage drift.
      // Validate their shape after checking the full document for relationships;
      // retain every other fact, including nested or aliased counter fields.
      for (const counter of ["blocks_free", "blocks_avail"]) {
        if (!(counter in storageFacts)) continue;
        const value = storageFacts[counter];
        if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
          return blocked();
        }
        delete storageFacts[counter];
      }
      volumes.push(storageFacts);
    }
    return {
      state: "complete",
      fingerprint: observationFingerprint(
        volumes.sort((left, right) => left.id.localeCompare(right.id)),
      ),
    };
  } catch {
    return blocked();
  }
}

function isSafeLeaseNonce(value: unknown): value is string {
  return typeof value === "string" && /^[\x21-\x7E]{1,256}$/u.test(value);
}

async function observeActiveMachineAbsence(
  input: { machineId: string; projectId: number },
  request: LegacyFlyRetirementRequest,
): Promise<
  | { state: "complete"; fingerprint: string }
  | Extract<LegacyFlyRuntimeReconciliation, { state: "retained" }>
> {
  const blocked = () => retained("absence_unverified", true);
  const observation = await requestSafely(request, { resource: "machines", method: "GET" });
  if (!observation) return blocked();
  try {
    const body = await readCompleteCatalog(observation, MAX_MACHINE_CATALOG_ROWS);
    const ids = new Set<string>();
    const names = new Set<string>();
    const identities: Array<{ id: string; name: string; projectId: string | null }> = [];
    for (const row of body) {
      if (
        !isRecord(row) ||
        typeof row.id !== "string" ||
        !LEGACY_FLY_MACHINE_ID.test(row.id) ||
        typeof row.name !== "string" ||
        !LEGACY_FLY_MACHINE_ID.test(row.name) ||
        typeof row.state !== "string" ||
        !LEGACY_FLY_MACHINE_ID.test(row.state) ||
        row.state === "destroyed" ||
        !isRecord(row.config) ||
        ("env" in row.config && !isRecord(row.config.env)) ||
        ids.has(row.id) ||
        names.has(row.name) ||
        row.id === input.machineId ||
        row.name === "project-" + input.projectId
      ) {
        return blocked();
      }
      const projectIds = new Set<string>();
      const namedProject = /^project-([1-9]\d*)$/u.exec(row.name)?.[1];
      if (namedProject !== undefined) projectIds.add(namedProject);
      let ambiguous = false;
      walkDocument(row, (value, path) => {
        const key = path[path.length - 1];
        if (typeof key !== "string") return;
        const marker = normalizedMarker(key);
        if (["hasmore", "nextcursor", "nextpage"].includes(marker)) ambiguous = true;
        if (marker === "machineid" && value !== row.id) ambiguous = true;
        if (marker === "projectname" && value !== row.name) ambiguous = true;
        if (marker.endsWith("projectid")) {
          const projectId =
            typeof value === "string"
              ? value
              : typeof value === "number" && Number.isSafeInteger(value)
                ? String(value)
                : "";
          if (!/^[1-9]\d*$/u.test(projectId) || !Number.isSafeInteger(Number(projectId))) {
            ambiguous = true;
          } else {
            projectIds.add(projectId);
          }
        }
      });
      const projectId = projectIds.values().next().value ?? null;
      if (ambiguous || projectIds.size > 1 || projectId === String(input.projectId)) {
        return blocked();
      }
      ids.add(row.id);
      names.add(row.name);
      // Preview and production machines may share an unrelated project owner.
      // Uniqueness belongs to machine IDs/names, never to other owners' IDs.
      // Repeat the catalog's identity set, without unrelated lifecycle telemetry.
      // Every row's complete document is still bounded and checked above.
      identities.push({ id: row.id, name: row.name, projectId });
    }
    return {
      state: "complete",
      fingerprint: observationFingerprint(identities.sort((a, b) => a.id.localeCompare(b.id))),
    };
  } catch {
    return blocked();
  }
}

/**
 * Fly's unversioned GET can retain a destroyed tombstone ("No longer exists").
 * A 200 or a version-terminal migrated/replaced state is never absence proof.
 * Require repeated exact owned tombstones, active catalog absence and storage
 * absence under durable authority; never acquire a lease or mutate a tombstone.
 * https://fly.io/docs/machines/machine-states/
 * https://fly.io/docs/machines/api/machines-resource/#list-machines
 */
async function verifyDestroyedTombstone(
  input: { machineId: string; projectId: number; assertAuthority: () => Promise<void> },
  machine: Extract<Awaited<ReturnType<typeof observeMachine>>, { state: "complete" }>,
  request: LegacyFlyRetirementRequest,
  leaseNonce?: string,
  previousVolumeFingerprint?: string,
): Promise<{ state: "complete" } | Extract<LegacyFlyRuntimeReconciliation, { state: "retained" }>> {
  if (
    machine.machineState !== "destroyed" ||
    (leaseNonce !== undefined && machine.nonce !== undefined && machine.nonce !== leaseNonce)
  ) {
    return retained("absence_unverified", true);
  }
  await input.assertAuthority();
  const active = await observeActiveMachineAbsence(input, request);
  if (active.state === "retained") return active;
  const volumes = await observeUnmountedVolumeCatalog(input.machineId, request);
  if (volumes.state === "retained") return volumes;
  if (
    previousVolumeFingerprint !== undefined &&
    volumes.fingerprint !== previousVolumeFingerprint
  ) {
    return retained("storage_ownership_ambiguous", false);
  }
  await input.assertAuthority();
  const response = await requestSafely(request, {
    machineId: input.machineId,
    method: "GET",
    ...(leaseNonce !== undefined ? { leaseNonce } : {}),
  });
  if (response?.status !== 200) return retained("absence_unverified", true);
  const fresh = await observeMachine(response, input);
  if (fresh.state === "retained") return fresh;
  if (
    fresh.machineState !== "destroyed" ||
    fresh.fingerprint !== machine.fingerprint ||
    (leaseNonce !== undefined && fresh.nonce !== undefined && fresh.nonce !== leaseNonce)
  ) {
    return retained("absence_unverified", true);
  }
  const freshActive = await observeActiveMachineAbsence(input, request);
  if (freshActive.state === "retained") return freshActive;
  if (freshActive.fingerprint !== active.fingerprint) return retained("absence_unverified", true);
  const freshVolumes = await observeUnmountedVolumeCatalog(input.machineId, request);
  if (freshVolumes.state === "retained") return freshVolumes;
  if (freshVolumes.fingerprint !== volumes.fingerprint) {
    return retained("storage_ownership_ambiguous", false);
  }
  await input.assertAuthority();
  return { state: "complete" };
}

/**
 * Internal authority checks deliberately propagate the coordinator's native
 * lease-lost error. Provider failures are sanitized; authority failures must
 * stop the stale worker without persisting a new public receipt.
 */
export async function reconcileLegacyFlyRuntime(
  input: { machineId: string; projectId: number; assertAuthority: () => Promise<void> },
  request: LegacyFlyRetirementRequest = requestThroughContainer,
): Promise<LegacyFlyRuntimeReconciliation> {
  if (
    !Number.isSafeInteger(input.projectId) ||
    input.projectId <= 0 ||
    typeof input.machineId !== "string" ||
    !LEGACY_FLY_MACHINE_ID.test(input.machineId)
  ) {
    return retained("legacy_pointer_malformed", false);
  }
  if (typeof input.assertAuthority !== "function") {
    return retained("provider_observation_unavailable", true);
  }

  const observation = await requestSafely(request, { machineId: input.machineId, method: "GET" });
  if (!observation) return retained("provider_observation_unavailable", true);
  if (observation.status === 404) {
    const catalog = await observeUnmountedVolumeCatalog(input.machineId, request);
    if (catalog.state === "retained") return catalog;
    const fresh = await requestSafely(request, { machineId: input.machineId, method: "GET" });
    if (fresh?.status !== 404) return retained("absence_unverified", true);
    await input.assertAuthority();
    return { state: "verified_absent", proof: "initial_get_404" };
  }
  if (observation.status !== 200) return retained("provider_observation_unavailable", true);
  const machine = await observeMachine(observation, input);
  if (machine.state === "retained") return machine;
  if (machine.machineState === "destroyed") {
    const proof = await verifyDestroyedTombstone(input, machine, request);
    if (proof.state === "retained") return proof;
    return {
      state: "verified_absent",
      proof: "initial_destroyed_tombstone_active_catalog_absent",
    };
  }
  const catalog = await observeUnmountedVolumeCatalog(input.machineId, request);
  if (catalog.state === "retained") return catalog;

  await input.assertAuthority();
  const acquisitionStartedAt = Date.now();
  const lease = await requestSafely(request, {
    resource: "lease",
    machineId: input.machineId,
    method: "POST",
    description: "Legacy runtime retirement",
    ttl: MACHINE_LEASE_TTL_SECONDS,
  });
  if (lease?.status !== 201) return retained("provider_observation_unavailable", true);

  let leaseNonce: string | null = null;
  let expiresAt: number;
  let proof: Extract<LegacyFlyRuntimeReconciliation, { state: "verified_absent" }>["proof"] =
    "delete_then_get_404";
  try {
    try {
      const leaseDocument = await readBoundedJson(lease);
      if (!isRecord(leaseDocument) || !isRecord(leaseDocument.data)) {
        return retained("provider_response_invalid", false);
      }
      const data = leaseDocument.data;
      // Preserve a valid nonce for finally even if the rest of the lease is invalid.
      if (isSafeLeaseNonce(data.nonce)) leaseNonce = data.nonce;
      if (
        leaseDocument.status !== "success" ||
        leaseNonce === null ||
        typeof data.expires_at !== "number" ||
        !Number.isSafeInteger(data.expires_at) ||
        !["owner", "description", "version"].every(
          (key) => typeof data[key] === "string" && data[key].length > 0 && data[key].length <= 256,
        )
      ) {
        return retained("provider_response_invalid", false);
      }
      expiresAt = data.expires_at * 1_000;
      if (
        expiresAt > acquisitionStartedAt + (MACHINE_LEASE_TTL_SECONDS + 5) * 1_000 ||
        expiresAt - Date.now() <= MIN_MUTATION_LEASE_MS
      ) {
        return retained("provider_observation_unavailable", true);
      }
    } catch {
      return retained("provider_response_invalid", false);
    }

    if (machine.nonce !== undefined && machine.nonce !== leaseNonce) {
      return retained("provider_response_invalid", false);
    }
    const currentResponse = await requestSafely(request, {
      machineId: input.machineId,
      method: "GET",
      leaseNonce,
    });
    if (currentResponse?.status !== 200) {
      return retained("provider_observation_unavailable", true);
    }
    const current = await observeMachine(currentResponse, input);
    if (current.state === "retained") return current;
    if (current.nonce !== undefined && current.nonce !== leaseNonce) {
      return retained("provider_response_invalid", false);
    }
    if (machine.fingerprint !== current.fingerprint) {
      return retained("storage_ownership_ambiguous", false);
    }
    const currentCatalog = await observeUnmountedVolumeCatalog(input.machineId, request);
    if (currentCatalog.state === "retained") return currentCatalog;
    if (catalog.fingerprint !== currentCatalog.fingerprint) {
      return retained("storage_ownership_ambiguous", false);
    }

    // Only the documented started state is eligible for STOP. In particular,
    // suspended machines carry snapshots that STOP would invalidate, and an
    // auto-destroy configuration could turn STOP into an unfenced deletion.
    if (current.machineState !== "started" && current.machineState !== "stopped") {
      return retained("provider_observation_unavailable", true);
    }
    if (current.machineState === "started") {
      if (current.instanceId === null || current.stopFingerprint === null) {
        return retained("provider_response_invalid", false);
      }
      if (!current.canStopWithoutAutoDestroy) {
        return retained("storage_ownership_ambiguous", false);
      }
      await input.assertAuthority();
      if (expiresAt - Date.now() <= MIN_MUTATION_LEASE_MS) {
        return retained("provider_observation_unavailable", true);
      }
      // Normal Fly STOP with its default graceful signal, never force or a
      // caller-controlled signal/timeout. Never retry this mutation in place.
      const stop = await requestSafely(request, {
        resource: "stop",
        machineId: input.machineId,
        method: "POST",
        leaseNonce,
      });
      if (stop?.status !== 200) return retained("provider_delete_unavailable", true);

      await input.assertAuthority();
      if (expiresAt - Date.now() <= MIN_MUTATION_LEASE_MS) {
        return retained("provider_observation_unavailable", true);
      }
      const wait = await requestSafely(request, {
        resource: "wait",
        machineId: input.machineId,
        method: "GET",
        instanceId: current.instanceId,
        leaseNonce,
      });
      // A wait acknowledgement alone is not stopped-state or ownership proof.
      if (wait?.status !== 200) return retained("provider_observation_unavailable", true);
      await input.assertAuthority();
      if (expiresAt - Date.now() <= MIN_MUTATION_LEASE_MS) {
        return retained("provider_observation_unavailable", true);
      }
      const stoppedResponse = await requestSafely(request, {
        machineId: input.machineId,
        method: "GET",
        leaseNonce,
      });
      if (stoppedResponse?.status !== 200) {
        return retained("provider_observation_unavailable", true);
      }
      const stopped = await observeMachine(stoppedResponse, input);
      if (stopped.state === "retained") return stopped;
      if (stopped.nonce !== undefined && stopped.nonce !== leaseNonce) {
        return retained("provider_response_invalid", false);
      }
      if (stopped.machineState !== "stopped") {
        return retained("provider_observation_unavailable", true);
      }
      if (
        stopped.instanceId !== current.instanceId ||
        stopped.stopFingerprint === null ||
        stopped.stopFingerprint !== current.stopFingerprint
      ) {
        return retained("storage_ownership_ambiguous", false);
      }
      const stoppedCatalog = await observeUnmountedVolumeCatalog(input.machineId, request);
      if (stoppedCatalog.state === "retained") return stoppedCatalog;
      if (stoppedCatalog.fingerprint !== currentCatalog.fingerprint) {
        return retained("storage_ownership_ambiguous", false);
      }
    }

    await input.assertAuthority();
    if (expiresAt - Date.now() <= MIN_MUTATION_LEASE_MS) {
      return retained("provider_observation_unavailable", true);
    }
    const deletion = await requestSafely(request, {
      machineId: input.machineId,
      method: "DELETE",
      leaseNonce,
    });
    if (
      !deletion ||
      (deletion.status !== 404 && (deletion.status < 200 || deletion.status >= 300))
    ) {
      return retained("provider_delete_unavailable", true);
    }
    const verification = await requestSafely(request, {
      machineId: input.machineId,
      method: "GET",
      leaseNonce,
    });
    if (verification?.status === 200) {
      const tombstone = await observeMachine(verification, input);
      if (tombstone.state === "retained" || tombstone.machineState !== "destroyed") {
        return retained("absence_unverified", true);
      }
      const verified = await verifyDestroyedTombstone(
        input,
        tombstone,
        request,
        leaseNonce,
        currentCatalog.fingerprint,
      );
      if (verified.state === "retained") return verified;
      proof = "delete_then_destroyed_tombstone_active_catalog_absent";
    } else {
      if (verification?.status !== 404) return retained("absence_unverified", true);
      const finalCatalog = await observeUnmountedVolumeCatalog(input.machineId, request);
      if (finalCatalog.state === "retained") return finalCatalog;
      if (currentCatalog.fingerprint !== finalCatalog.fingerprint) {
        return retained("storage_ownership_ambiguous", false);
      }
    }
    if (expiresAt <= Date.now()) return retained("absence_unverified", true);
  } finally {
    if (leaseNonce !== null) {
      // A destroyed machine may return 404 here. Never expose lease documents or
      // retry a mutation after its observation/authority window has changed.
      await requestSafely(request, {
        resource: "lease",
        machineId: input.machineId,
        method: "DELETE",
        leaseNonce,
      });
    }
  }
  await input.assertAuthority();
  if (expiresAt <= Date.now()) return retained("absence_unverified", true);
  return { state: "verified_absent", proof };
}
