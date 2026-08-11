import {
  ACCEPTANCE_JANITOR_BATCH_LIMIT,
  ACCEPTANCE_LEASE_MAX_COST_MINOR_UNITS,
  acceptanceLeaseCreateRequestSchema,
  acceptanceLeaseIdentity,
  acceptanceLeaseMutationRequestSchema,
  acceptanceOperationIdentity,
  acceptanceProvisionCapabilityRequestSchema,
  acceptanceProvisionFlySecretRequestSchema,
  type AcceptanceErrorCode,
  type AcceptanceLeaseJobRequest,
  type AcceptanceLeaseOperation,
  type AcceptanceLeaseResponse,
  type AcceptanceVerifyGoneResponse,
  type CapabilityDefinition,
} from "@workspace/tenant-runtime-contracts";
import type { CapabilityVaultDurableObject } from "./capability-vault-durable-object";
import type { AcceptanceVaultDurableObject } from "./acceptance-vault-durable-object";
import type { ControlDurableObject } from "./control-durable-object";
import {
  AcceptanceProviderError,
  NativeAcceptanceProviderAdapters,
} from "./acceptance-provider-adapters";
import type {
  AcceptanceLeaseOperationResult,
  AcceptanceProviderAdapters,
  AcceptanceProvisionerBindings,
  AcceptanceQueueMessage,
  AcceptanceWorkloadIdentity,
  AcceptanceWorkloadVerifier,
  StoredAcceptanceLease,
} from "./acceptance-provisioner-model";
import { Es256AcceptanceWorkloadVerifier } from "./acceptance-workload-identity";
import type {
  ControlCoordinator,
  DurableOperationClaim,
  DurableOperationDriverClaim,
  DurableOperationQueueMessage,
  StoredDurableOperationJob,
  StoredHttpResponse,
} from "./model";

const API_PREFIX = "/_nabuflow/acceptance/v1";
const MAX_REQUEST_BYTES = 64 * 1024;
const OPERATION_HEARTBEAT_MS = 5_000;
const PROVIDER_RETRY_DELAYS_MS = [0, 250, 750] as const;

const DATABASE_DEFINITION: CapabilityDefinition = {
  name: "database",
  provider: "neon-postgres",
  allowedMethods: ["POST"],
  allowedPaths: [{ match: "exact", path: "/v1/query" }],
  injection: { location: "worker-binding" },
  limits: {
    timeoutMs: 10_000,
    maxRequestBytes: 65_536,
    maxResponseBytes: 262_144,
    maxRequestsPerMinute: 60,
    maxConcurrent: 4,
  },
};

const STRIPE_DEFINITION: CapabilityDefinition = {
  name: "payments",
  provider: "stripe",
  allowedMethods: ["POST"],
  allowedPaths: [{ match: "exact", path: "/v1/payment-intents" }],
  injection: { location: "worker-binding" },
  limits: {
    timeoutMs: 10_000,
    maxRequestBytes: 8_192,
    maxResponseBytes: 65_536,
    maxRequestsPerMinute: 60,
    maxConcurrent: 4,
  },
};

class AcceptanceHttpError extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 404 | 409 | 413 | 429 | 500 | 502 | 503 | 504,
    readonly code: AcceptanceErrorCode,
    readonly retryable: boolean,
  ) {
    super("The staging acceptance operation could not be completed");
  }
}

function vault(
  env: AcceptanceProvisionerBindings,
): DurableObjectStub<AcceptanceVaultDurableObject> {
  return env.ACCEPTANCE_VAULT.get(env.ACCEPTANCE_VAULT.idFromName("acceptance-vault"));
}

function coordinator(env: AcceptanceProvisionerBindings): DurableObjectStub<ControlDurableObject> {
  return env.ACCEPTANCE_COORDINATOR.get(
    env.ACCEPTANCE_COORDINATOR.idFromName("acceptance-coordinator"),
  );
}

function capabilityVault(
  env: AcceptanceProvisionerBindings,
  projectId: number,
): DurableObjectStub<CapabilityVaultDurableObject> {
  return env.CAPABILITY_VAULT.get(env.CAPABILITY_VAULT.idFromName(`project:${projectId}`));
}

function json(body: unknown, status = 200, extraHeaders: HeadersInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...extraHeaders },
  });
}

function errorResponse(error: AcceptanceHttpError, requestId: string): Response {
  return json(
    {
      ok: false,
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      requestId,
    },
    error.status,
    error.retryable ? { "retry-after": "1" } : {},
  );
}

function publicLease(lease: StoredAcceptanceLease): AcceptanceLeaseResponse {
  return {
    ok: true,
    schemaVersion: 1,
    leaseId: lease.leaseId,
    provider: lease.scope.provider,
    resourceIds: lease.resource?.ids ?? [],
    state: lease.state,
    createdAt: new Date(lease.createdAtMs).toISOString(),
    updatedAt: new Date(lease.updatedAtMs).toISOString(),
    expiresAt: new Date(lease.expiresAtMs).toISOString(),
    cost: {
      currency: "USD",
      amountMinorUnits: lease.costAmountMinorUnits,
      ceilingMinorUnits: lease.costCeilingMinorUnits,
    },
  };
}

async function readJsonBody(request: Request): Promise<unknown> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_REQUEST_BYTES) {
    throw new AcceptanceHttpError(413, "acceptance_invalid_request", false);
  }
  const bytes = new Uint8Array(await request.arrayBuffer());
  try {
    if (bytes.byteLength > MAX_REQUEST_BYTES) {
      throw new AcceptanceHttpError(413, "acceptance_invalid_request", false);
    }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch (error) {
    if (error instanceof AcceptanceHttpError) throw error;
    throw new AcceptanceHttpError(400, "acceptance_invalid_request", false);
  } finally {
    bytes.fill(0);
  }
}

function assertEnabled(env: AcceptanceProvisionerBindings): void {
  if (env.ACCEPTANCE_STAGING_ENABLED !== "true") {
    throw new AcceptanceHttpError(404, "acceptance_lease_not_found", false);
  }
}

function assertScope(
  leaseScope:
    | StoredAcceptanceLease["scope"]
    | ReturnType<typeof acceptanceLeaseCreateRequestSchema.parse>["scope"],
  env: AcceptanceProvisionerBindings,
): void {
  const valid =
    (leaseScope.provider === "neon" &&
      leaseScope.organizationId === env.ACCEPTANCE_NEON_ORGANIZATION_ID) ||
    (leaseScope.provider === "stripe" &&
      leaseScope.mode === "test" &&
      leaseScope.sandboxId === env.ACCEPTANCE_STRIPE_SANDBOX_ID) ||
    (leaseScope.provider === "fly" &&
      leaseScope.disposable &&
      leaseScope.organizationSlug === env.ACCEPTANCE_FLY_ORGANIZATION_SLUG);
  if (!valid) throw new AcceptanceHttpError(403, "acceptance_scope_mismatch", false);
}

function parseLeaseRoute(pathname: string):
  | { kind: "collection" }
  | {
      kind: "lease";
      leaseId: string;
      action:
        | "status"
        | "provision-capability"
        | "provision-fly-secret"
        | "destroy"
        | "verify-gone";
    }
  | null {
  if (pathname === `${API_PREFIX}/leases`) return { kind: "collection" };
  const match = new RegExp(
    `^${API_PREFIX.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}/leases/(nal_[A-Za-z0-9_-]{22,80})/(status|provision-capability|provision-fly-secret|destroy|verify-gone)$`,
    "u",
  ).exec(pathname);
  if (match === null) return null;
  return { kind: "lease", leaseId: match[1], action: match[2] as never };
}

function leaseIdFromDigest(digest: string): string {
  return `nal_${digest.slice(0, 40)}`;
}

function operationSubject(operation: AcceptanceLeaseOperation): string {
  return operation;
}

async function loadAuthorizedLease(
  env: AcceptanceProvisionerBindings,
  leaseId: string,
  identity: AcceptanceWorkloadIdentity,
): Promise<StoredAcceptanceLease> {
  const lease = await vault(env).getAuthorizedLease(leaseId, identity.subjectHash);
  if (lease === null) throw new AcceptanceHttpError(403, "acceptance_scope_mismatch", false);
  assertScope(lease.scope, env);
  return lease;
}

async function dispatchOperation(input: {
  env: AcceptanceProvisionerBindings;
  identity: AcceptanceWorkloadIdentity;
  lease: StoredAcceptanceLease;
  operation: AcceptanceLeaseOperation;
  body: unknown;
  idempotencyKey: string;
  request: AcceptanceLeaseJobRequest;
}): Promise<Response> {
  const fingerprint = await acceptanceOperationIdentity({
    leaseId: input.lease.leaseId,
    operation: input.operation,
    body: input.body,
  });
  const control = coordinator(input.env);
  const claim = (await control.registerDurableOperation({
    key: input.idempotencyKey,
    fingerprint,
    kind: "acceptance-lease",
    runtimeIdentity: `acceptance:${input.lease.leaseId}`,
    subjectKey: operationSubject(input.operation),
    request: input.request,
    expectedDeploymentVersion: input.env.CF_VERSION_METADATA.id,
    nowMs: Date.now(),
  })) as DurableOperationClaim;
  if (claim.state === "conflict") {
    throw new AcceptanceHttpError(409, "acceptance_idempotency_conflict", false);
  }
  if (claim.state === "replay") return json(claim.response.body, claim.response.status);
  const job = claim.job;
  if (job !== undefined) {
    await control.recordDurableOperationNudge(job.jobKey, Date.now());
    await input.env.ACCEPTANCE_OPERATION_QUEUE.send({
      schemaVersion: 1,
      jobKey: job.jobKey,
      runtimeIdentity: job.runtimeIdentity,
      subjectKey: job.subjectKey,
      kind: job.kind,
    });
  }
  const current = await loadAuthorizedLease(input.env, input.lease.leaseId, input.identity);
  return json(publicLease(current), 202, { "retry-after": "1" });
}

function requiredIdempotencyKey(request: Request): string {
  const value = request.headers.get("idempotency-key");
  if (value === null || value.length < 16 || value.length > 200 || !/^[\x21-\x7e]+$/u.test(value)) {
    throw new AcceptanceHttpError(400, "acceptance_invalid_request", false);
  }
  return value;
}

export class AcceptanceProvisionerService {
  constructor(
    private readonly env: AcceptanceProvisionerBindings,
    private readonly verifier: AcceptanceWorkloadVerifier = new Es256AcceptanceWorkloadVerifier(
      env,
    ),
    private readonly providers: AcceptanceProviderAdapters = new NativeAcceptanceProviderAdapters(
      env,
    ),
  ) {}

  async handle(request: Request): Promise<Response> {
    const requestId = crypto.randomUUID();
    try {
      assertEnabled(this.env);
      const identity = await this.verifier.verify(request, Date.now());
      if (identity === null) {
        throw new AcceptanceHttpError(401, "acceptance_unauthorized", false);
      }
      const route = parseLeaseRoute(new URL(request.url).pathname);
      if (route === null) throw new AcceptanceHttpError(404, "acceptance_lease_not_found", false);
      if (route.kind === "collection") {
        if (request.method !== "POST") {
          throw new AcceptanceHttpError(404, "acceptance_lease_not_found", false);
        }
        const idempotencyKey = requiredIdempotencyKey(request);
        const body = acceptanceLeaseCreateRequestSchema.safeParse(await readJsonBody(request));
        if (!body.success) throw new AcceptanceHttpError(400, "acceptance_invalid_request", false);
        assertScope(body.data.scope, this.env);
        const configuredMax = Number(this.env.ACCEPTANCE_PROVIDER_MAX_COST_MINOR_UNITS);
        if (
          !Number.isSafeInteger(configuredMax) ||
          configuredMax < 0 ||
          configuredMax > ACCEPTANCE_LEASE_MAX_COST_MINOR_UNITS ||
          body.data.costCeilingMinorUnits > configuredMax
        ) {
          throw new AcceptanceHttpError(403, "acceptance_cost_ceiling_exceeded", false);
        }
        const identityHash = await acceptanceLeaseIdentity(body.data);
        const leaseDigest = await acceptanceOperationIdentity({
          leaseId: "nal_0000000000000000000000",
          operation: "create",
          body: { owner: identity.subjectHash, idempotencyKey },
        });
        const leaseId = leaseIdFromDigest(leaseDigest);
        const created = await vault(this.env).createLease({
          leaseId,
          identityHash,
          ownerSubjectHash: identity.subjectHash,
          request: body.data,
          nowMs: Date.now(),
        });
        if (created.state === "conflict") {
          throw new AcceptanceHttpError(409, "acceptance_idempotency_conflict", false);
        }
        return dispatchOperation({
          env: this.env,
          identity,
          lease: created.lease,
          operation: "create",
          body: body.data,
          idempotencyKey,
          request: {
            leaseId,
            operation: "create",
            ownerSubjectHash: identity.subjectHash,
          },
        });
      }
      const lease = await loadAuthorizedLease(this.env, route.leaseId, identity);
      if (route.action === "status") {
        if (request.method !== "GET") {
          throw new AcceptanceHttpError(404, "acceptance_lease_not_found", false);
        }
        return json(publicLease(lease));
      }
      if (request.method !== "POST") {
        throw new AcceptanceHttpError(404, "acceptance_lease_not_found", false);
      }
      const idempotencyKey = requiredIdempotencyKey(request);
      const rawBody = await readJsonBody(request);
      let body: unknown;
      let job: AcceptanceLeaseJobRequest;
      if (route.action === "provision-capability") {
        const parsed = acceptanceProvisionCapabilityRequestSchema.safeParse(rawBody);
        if (!parsed.success)
          throw new AcceptanceHttpError(400, "acceptance_invalid_request", false);
        if (lease.scope.provider === "fly") {
          throw new AcceptanceHttpError(403, "acceptance_scope_mismatch", false);
        }
        if (lease.scope.provider === "stripe" && parsed.data.stripePolicy === undefined) {
          throw new AcceptanceHttpError(400, "acceptance_invalid_request", false);
        }
        body = parsed.data;
        job = {
          leaseId: lease.leaseId,
          operation: "provision-capability",
          ownerSubjectHash: identity.subjectHash,
          revision: parsed.data.revision,
          stripePolicy: parsed.data.stripePolicy,
        };
      } else if (route.action === "provision-fly-secret") {
        const parsed = acceptanceProvisionFlySecretRequestSchema.safeParse(rawBody);
        if (!parsed.success)
          throw new AcceptanceHttpError(400, "acceptance_invalid_request", false);
        if (lease.scope.provider !== "fly") {
          throw new AcceptanceHttpError(403, "acceptance_scope_mismatch", false);
        }
        await loadAuthorizedLease(this.env, parsed.data.databaseLeaseId, identity);
        body = parsed.data;
        job = {
          leaseId: lease.leaseId,
          operation: "provision-fly-secret",
          ownerSubjectHash: identity.subjectHash,
          databaseLeaseId: parsed.data.databaseLeaseId,
        };
      } else {
        const parsed = acceptanceLeaseMutationRequestSchema.safeParse(rawBody);
        if (!parsed.success)
          throw new AcceptanceHttpError(400, "acceptance_invalid_request", false);
        body = parsed.data;
        job = {
          leaseId: lease.leaseId,
          operation: route.action,
          ownerSubjectHash: identity.subjectHash,
        };
      }
      return dispatchOperation({
        env: this.env,
        identity,
        lease,
        operation: job.operation,
        body,
        idempotencyKey,
        request: job,
      });
    } catch (error) {
      if (error instanceof AcceptanceHttpError) return errorResponse(error, requestId);
      return errorResponse(
        new AcceptanceHttpError(500, "acceptance_internal_error", false),
        requestId,
      );
    }
  }

  async handleQueue(message: DurableOperationQueueMessage): Promise<void> {
    if (message.kind !== "acceptance-lease") return;
    const control = coordinator(this.env);
    const ownerId = crypto.randomUUID();
    const claim = (await control.claimDurableOperationDriver(
      message.jobKey,
      ownerId,
      Date.now(),
    )) as DurableOperationDriverClaim;
    if (claim.state === "not_found" || claim.state === "terminal" || claim.state === "busy") return;
    const job = claim.job;
    if (job.kind !== "acceptance-lease") return;
    const heartbeat = setInterval(() => {
      void control
        .renewDurableOperation(job.jobKey, ownerId, job.attempt, Date.now())
        .catch(() => undefined);
    }, OPERATION_HEARTBEAT_MS);
    try {
      const result = await this.executeJob(job, ownerId);
      const stored: StoredHttpResponse = { status: result.status, body: result.response };
      await control.completeDurableOperation(job.jobKey, ownerId, job.attempt, stored, Date.now());
    } catch (error) {
      const typed = translateOperationError(error);
      const stored: StoredHttpResponse = {
        status: typed.status,
        body: {
          ok: false,
          code: typed.code,
          message: typed.message,
          retryable: typed.retryable,
          requestId: crypto.randomUUID(),
        },
      };
      await vault(this.env)
        .markFailed({
          leaseId: job.request.leaseId,
          ownerSubjectHash: job.request.ownerSubjectHash,
          code: typed.code,
          nowMs: Date.now(),
        })
        .catch(() => null);
      await control
        .failDurableOperation(job.jobKey, ownerId, job.attempt, stored, Date.now())
        .catch(() => undefined);
    } finally {
      clearInterval(heartbeat);
    }
  }

  async handleJanitorSignal(leaseId: string, nowMs = Date.now()): Promise<void> {
    const lease = await vault(this.env).getLeaseForJanitor(leaseId);
    if (lease !== null && lease.expiresAtMs <= nowMs && lease.state !== "destroyed") {
      await registerJanitorDestroy(this.env, lease);
    }
  }

  async reconcileJanitor(nowMs = Date.now()): Promise<{ inspected: number; reclaimed: number }> {
    const leases = await vault(this.env).listLeases(ACCEPTANCE_JANITOR_BATCH_LIMIT);
    return this.providers.reconcile(leases, nowMs);
  }

  private async executeJob(
    job: Extract<StoredDurableOperationJob, { kind: "acceptance-lease" }>,
    ownerId: string,
  ): Promise<AcceptanceLeaseOperationResult> {
    const control = coordinator(this.env);
    const checkpoint = async (
      value: Parameters<ControlCoordinator["checkpointDurableOperation"]>[0]["checkpoint"],
    ) => {
      await control.checkpointDurableOperation({
        jobKey: job.jobKey,
        ownerId,
        ownerGeneration: job.attempt,
        checkpoint: value,
        nowMs: Date.now(),
      });
    };
    let lease = await vault(this.env).getAuthorizedLease(
      job.request.leaseId,
      job.request.ownerSubjectHash,
    );
    if (lease === null) throw new AcceptanceHttpError(403, "acceptance_scope_mismatch", false);
    assertScope(lease.scope, this.env);
    await checkpoint("scope-verified");

    if (job.request.operation === "create") {
      const activeLease = lease;
      const result = await withProviderRetry(() => this.providers.create(activeLease));
      await checkpoint("provider-complete");
      lease = await vault(this.env).storeProviderResult({
        leaseId: lease.leaseId,
        ownerSubjectHash: lease.ownerSubjectHash,
        resource: result.resource,
        material: result.material,
        costAmountMinorUnits: result.costAmountMinorUnits,
        nowMs: Date.now(),
      });
      if (lease === null) throw new AcceptanceHttpError(403, "acceptance_scope_mismatch", false);
      await checkpoint("vault-complete");
      await checkpoint("verified-gone");
      await checkpoint("finalized");
      await this.audit(lease, "create", "succeeded");
      return { response: publicLease(lease), status: 201 };
    }

    if (job.request.operation === "provision-capability") {
      await checkpoint("provider-complete");
      const revision = job.request.revision;
      if (revision === undefined) {
        throw new AcceptanceHttpError(400, "acceptance_invalid_request", false);
      }
      const target = capabilityVault(this.env, lease.projectId);
      if (lease.scope.provider === "neon") {
        const connectionString = await vault(this.env).readMaterial({
          leaseId: lease.leaseId,
          ownerSubjectHash: lease.ownerSubjectHash,
          kind: "neon-connection-string",
        });
        if (connectionString === null) {
          throw new AcceptanceHttpError(503, "acceptance_provider_unavailable", false);
        }
        await target.provisionDatabase({
          projectId: lease.projectId,
          revision,
          definition: DATABASE_DEFINITION,
          credential: { kind: "neon-connection-string", value: connectionString },
        });
      } else if (lease.scope.provider === "stripe") {
        const key = this.env.ACCEPTANCE_STRIPE_TEST_RESTRICTED_KEY;
        if (key === undefined || !/^r[k]_test_[A-Za-z0-9]+$/u.test(key)) {
          throw new AcceptanceHttpError(503, "acceptance_provider_unavailable", false);
        }
        const policy = job.request.stripePolicy;
        if (policy === undefined) {
          throw new AcceptanceHttpError(400, "acceptance_invalid_request", false);
        }
        await target.provisionStripe({
          projectId: lease.projectId,
          revision,
          definition: STRIPE_DEFINITION,
          policy,
          credential: { kind: "stripe-test-secret-key", value: key },
        });
      } else {
        throw new AcceptanceHttpError(403, "acceptance_scope_mismatch", false);
      }
      lease = await vault(this.env).markCapabilityProvisioned({
        leaseId: lease.leaseId,
        ownerSubjectHash: lease.ownerSubjectHash,
        revision,
        nowMs: Date.now(),
      });
      if (lease === null) throw new AcceptanceHttpError(403, "acceptance_scope_mismatch", false);
      await checkpoint("vault-complete");
      await checkpoint("verified-gone");
      await checkpoint("finalized");
      await this.audit(lease, "provision-capability", "succeeded");
      return { response: publicLease(lease), status: 200 };
    }

    if (job.request.operation === "provision-fly-secret") {
      const databaseLeaseId = job.request.databaseLeaseId;
      if (databaseLeaseId === undefined || lease.scope.provider !== "fly") {
        throw new AcceptanceHttpError(400, "acceptance_invalid_request", false);
      }
      const source = await vault(this.env).getAuthorizedLease(
        databaseLeaseId,
        job.request.ownerSubjectHash,
      );
      if (
        source === null ||
        source.projectId !== lease.projectId ||
        source.scope.provider !== "neon"
      ) {
        throw new AcceptanceHttpError(403, "acceptance_scope_mismatch", false);
      }
      const connectionString = await vault(this.env).readMaterial({
        leaseId: source.leaseId,
        ownerSubjectHash: source.ownerSubjectHash,
        kind: "neon-connection-string",
      });
      if (connectionString === null) {
        throw new AcceptanceHttpError(403, "acceptance_scope_mismatch", false);
      }
      await withProviderRetry(() => this.providers.writeFlyDatabaseUrl(lease!, connectionString));
      await checkpoint("provider-complete");
      lease.resource =
        lease.resource === null ? null : { ...lease.resource, configurationWritten: true };
      lease = await vault(this.env).storeProviderResult({
        leaseId: lease.leaseId,
        ownerSubjectHash: lease.ownerSubjectHash,
        resource: lease.resource!,
        material: null,
        costAmountMinorUnits: lease.costAmountMinorUnits,
        nowMs: Date.now(),
      });
      if (lease === null) throw new AcceptanceHttpError(403, "acceptance_scope_mismatch", false);
      await checkpoint("vault-complete");
      await checkpoint("verified-gone");
      await checkpoint("finalized");
      await this.audit(lease, "provision-fly-secret", "succeeded");
      return { response: publicLease(lease), status: 200 };
    }

    if (job.request.operation === "destroy") {
      lease =
        (await vault(this.env).markDestroying({
          leaseId: lease.leaseId,
          ownerSubjectHash: lease.ownerSubjectHash,
          nowMs: Date.now(),
        })) ?? lease;
      if (lease.capabilityRevision !== null) {
        const target = capabilityVault(this.env, lease.projectId);
        if (lease.scope.provider === "neon") {
          await target.revokeDatabase({
            projectId: lease.projectId,
            expectedRevision: lease.capabilityRevision,
          });
        } else if (lease.scope.provider === "stripe") {
          await target.revokeStripe({
            projectId: lease.projectId,
            expectedRevision: lease.capabilityRevision,
          });
        }
      }
      await withProviderRetry(() => this.providers.destroy(lease!));
      await checkpoint("provider-complete");
      await checkpoint("vault-complete");
      const gone = await withProviderRetry(() => this.providers.verifyGone(lease!));
      if (!gone.resourcesGone || !gone.configurationGone) {
        throw new AcceptanceHttpError(503, "acceptance_cleanup_incomplete", true);
      }
      await checkpoint("verified-gone");
      lease = await vault(this.env).markDestroyed({
        leaseId: lease.leaseId,
        ownerSubjectHash: lease.ownerSubjectHash,
        nowMs: Date.now(),
      });
      if (lease === null) throw new AcceptanceHttpError(403, "acceptance_scope_mismatch", false);
      await checkpoint("finalized");
      await this.audit(lease, "destroy", "succeeded");
      return { response: publicLease(lease), status: 200 };
    }

    const gone = await withProviderRetry(() => this.providers.verifyGone(lease!));
    await checkpoint("provider-complete");
    await checkpoint("vault-complete");
    if (!gone.resourcesGone || !gone.configurationGone) {
      throw new AcceptanceHttpError(503, "acceptance_cleanup_incomplete", true);
    }
    await checkpoint("verified-gone");
    lease =
      (await vault(this.env).markDestroyed({
        leaseId: lease.leaseId,
        ownerSubjectHash: lease.ownerSubjectHash,
        nowMs: Date.now(),
      })) ?? lease;
    await checkpoint("finalized");
    const response: AcceptanceVerifyGoneResponse = {
      ok: true,
      schemaVersion: 1,
      leaseId: lease.leaseId,
      state: "destroyed",
      resourcesGone: true,
      configurationGone: true,
      verifiedAt: new Date().toISOString(),
      cost: {
        currency: "USD",
        amountMinorUnits: gone.costAmountMinorUnits,
        ceilingMinorUnits: lease.costCeilingMinorUnits,
      },
    };
    await this.audit(lease, "verify-gone", "succeeded");
    return { response, status: 200 };
  }

  private async audit(
    lease: StoredAcceptanceLease,
    operation: AcceptanceLeaseOperation,
    outcome: string,
  ): Promise<void> {
    await vault(this.env)
      .recordAudit({
        at: new Date().toISOString(),
        leaseId: lease.leaseId,
        provider: lease.scope.provider,
        operation,
        outcome,
        state: lease.state,
        resourceCount: lease.resource?.ids.length ?? 0,
        costAmountMinorUnits: lease.costAmountMinorUnits,
      })
      .catch(() => undefined);
  }
}

async function withProviderRetry<T>(operation: () => Promise<T>): Promise<T> {
  let last: unknown;
  for (const delayMs of PROVIDER_RETRY_DELAYS_MS) {
    if (delayMs > 0) await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
    try {
      return await operation();
    } catch (error) {
      last = error;
      if (!(error instanceof AcceptanceProviderError) || !error.retryable) throw error;
    }
  }
  throw last;
}

function translateOperationError(error: unknown): AcceptanceHttpError {
  if (error instanceof AcceptanceHttpError) return error;
  if (error instanceof AcceptanceProviderError) {
    const status =
      error.code === "acceptance_live_target_forbidden" ||
      error.code === "acceptance_scope_mismatch"
        ? 403
        : error.code === "acceptance_provider_rejected"
          ? 502
          : error.code === "acceptance_cleanup_incomplete"
            ? 503
            : 503;
    return new AcceptanceHttpError(status, error.code, error.retryable);
  }
  return new AcceptanceHttpError(500, "acceptance_internal_error", false);
}

async function registerJanitorDestroy(
  env: AcceptanceProvisionerBindings,
  lease: StoredAcceptanceLease,
): Promise<void> {
  const control = coordinator(env);
  const body = { schemaVersion: 1, expiredAt: lease.expiresAtMs };
  const fingerprint = await acceptanceOperationIdentity({
    leaseId: lease.leaseId,
    operation: "destroy",
    body,
  });
  const claim = (await control.registerDurableOperation({
    key: `acceptance-janitor:${lease.leaseId}:${lease.expiresAtMs}`,
    fingerprint,
    kind: "acceptance-lease",
    runtimeIdentity: `acceptance:${lease.leaseId}`,
    subjectKey: "destroy",
    request: {
      leaseId: lease.leaseId,
      operation: "destroy",
      ownerSubjectHash: lease.ownerSubjectHash,
    },
    expectedDeploymentVersion: env.CF_VERSION_METADATA.id,
    nowMs: Date.now(),
  })) as DurableOperationClaim;
  if (claim.state === "new" || claim.state === "pending") {
    const job = claim.job;
    if (job !== undefined) {
      await env.ACCEPTANCE_OPERATION_QUEUE.send({
        schemaVersion: 1,
        jobKey: job.jobKey,
        runtimeIdentity: job.runtimeIdentity,
        subjectKey: job.subjectKey,
        kind: job.kind,
      });
    }
  }
}

export async function handleAcceptanceQueue(
  batch: MessageBatch<AcceptanceQueueMessage>,
  env: AcceptanceProvisionerBindings,
): Promise<void> {
  const service = new AcceptanceProvisionerService(env);
  for (const message of batch.messages) {
    try {
      if (message.body.kind === "acceptance-janitor") {
        await service.handleJanitorSignal(message.body.leaseId);
      } else {
        await service.handleQueue(message.body);
      }
      message.ack();
    } catch {
      message.retry();
    }
  }
}

export async function handleAcceptanceScheduled(env: AcceptanceProvisionerBindings): Promise<void> {
  if (env.ACCEPTANCE_STAGING_ENABLED !== "true") return;
  const store = vault(env);
  const due = await store.listExpired(Date.now(), ACCEPTANCE_JANITOR_BATCH_LIMIT);
  for (const lease of due) await registerJanitorDestroy(env, lease);
  const leases = await store.listLeases(ACCEPTANCE_JANITOR_BATCH_LIMIT);
  await new NativeAcceptanceProviderAdapters(env).reconcile(leases, Date.now());
}
