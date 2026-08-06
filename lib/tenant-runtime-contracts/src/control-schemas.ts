import { z } from "zod";
import {
  CONTROL_PROTOCOL_VERSION,
  RUNTIME_ROLES,
  RUNTIME_SLOTS,
  RUNTIME_STATUSES,
  slotIsValidForRole,
} from "./constants";
import { publishedHostnameSchema, routeRecordSchema } from "./route-capability";
import { parseRuntimeIdentity } from "./runtime-identity";
import { tenantServicePortSchema } from "./service-port";

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
const revisionSchema = z.string().min(1).max(200);
const deploymentVersionSchema = z.string().min(1).max(200);
const runtimeRoleSchema = z.enum(RUNTIME_ROLES);
const runtimeSlotSchema = z.enum(RUNTIME_SLOTS);
const argvEntrySchema = z
  .string()
  .max(16_384)
  .refine((value) => !value.includes("\0"), {
    message: "Command arguments cannot contain NUL bytes",
  });
const runtimePathSchema = z
  .string()
  .min(1)
  .max(1_000)
  .refine((path) => !path.includes("\0") && !path.includes("\\"), {
    message: "Runtime paths must be normalized POSIX paths",
  });
const relativeRuntimeFilePathSchema = runtimePathSchema.refine(
  (path) =>
    !path.startsWith("/") &&
    path !== ".." &&
    !path.startsWith("../") &&
    !path.endsWith("/..") &&
    !path.includes("/../") &&
    !path.split("/").includes("."),
  { message: "Runtime file paths must be normalized project-relative paths" },
);

export const runtimeLocatorSchema = z
  .object({
    projectId: z.number().int().positive().safe(),
    role: runtimeRoleSchema,
    slot: runtimeSlotSchema,
  })
  .strict()
  .superRefine((locator, context) => {
    if (!slotIsValidForRole(locator.role, locator.slot)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["slot"],
        message: `Slot ${locator.slot} is not valid for role ${locator.role}`,
      });
    }
  });

export type RuntimeLocator = z.infer<typeof runtimeLocatorSchema>;

export const runtimeManifestContractSchema = z
  .object({
    revision: revisionSchema,
    runtime: z.string().min(1).max(100),
    buildCommand: z.array(argvEntrySchema).min(1).max(256),
    startCommand: z.array(argvEntrySchema).min(1).max(256),
    servicePort: tenantServicePortSchema,
    healthPath: z
      .string()
      .min(1)
      .max(500)
      .regex(/^\/(?!\/)/)
      .refine((path) => !/[\r\n?#]/.test(path)),
    resourceProfile: z.string().min(1).max(100),
    public: z.boolean(),
  })
  .strict();

export type RuntimeManifestContract = z.infer<typeof runtimeManifestContractSchema>;

export const runtimeDescriptorSchema = z
  .object({
    identity: z.string().min(1).max(200),
    projectId: z.number().int().positive().safe(),
    role: runtimeRoleSchema,
    slot: runtimeSlotSchema,
    status: z.enum(RUNTIME_STATUSES),
    servicePort: tenantServicePortSchema,
    manifestRevision: revisionSchema,
    deploymentVersion: deploymentVersionSchema,
    endpoint: z.string().url().nullable(),
    readyAt: z.string().datetime().nullable(),
    lastError: z.string().max(2_000).nullable(),
  })
  .strict()
  .superRefine((runtime, context) => {
    if (!slotIsValidForRole(runtime.role, runtime.slot)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["slot"],
        message: `Slot ${runtime.slot} is not valid for role ${runtime.role}`,
      });
    }
    try {
      const identity = parseRuntimeIdentity(runtime.identity);
      if (
        identity.projectId !== runtime.projectId ||
        identity.role !== runtime.role ||
        identity.slot !== runtime.slot
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["identity"],
          message: "Runtime identity does not match its descriptor",
        });
      }
    } catch (error) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["identity"],
        message: error instanceof Error ? error.message : "Malformed runtime identity",
      });
    }
  });

export type RuntimeDescriptor = z.infer<typeof runtimeDescriptorSchema>;

const strictEmptySchema = z.object({}).strict();
const successSchema = z.object({ ok: z.literal(true) }).strict();
const runtimeResponseSchema = z.object({ runtime: runtimeDescriptorSchema }).strict();

export const controlErrorResponseSchema = z
  .object({
    ok: z.literal(false),
    code: z.string().min(1).max(100),
    message: z.string().min(1).max(2_000),
    retryable: z.boolean(),
    requestId: z.string().min(1).max(200),
  })
  .strict();

export const versionRequestSchema = strictEmptySchema;
export const versionResponseSchema = z
  .object({
    protocolVersion: z.literal(CONTROL_PROTOCOL_VERSION),
    deploymentVersion: deploymentVersionSchema,
    provider: z.literal("cloudflare"),
    supportedRoles: z.array(runtimeRoleSchema).min(1),
  })
  .strict();

export const ensureRuntimeRequestSchema = z
  .object({
    locator: runtimeLocatorSchema,
    expectedDeploymentVersion: deploymentVersionSchema,
    manifest: runtimeManifestContractSchema,
  })
  .strict();
export const ensureRuntimeResponseSchema = runtimeResponseSchema;

export const startRuntimeRequestSchema = z
  .object({
    locator: runtimeLocatorSchema,
    expectedDeploymentVersion: deploymentVersionSchema,
    artifactRevision: revisionSchema,
    artifactSha256: sha256Schema,
  })
  .strict();
export const startRuntimeResponseSchema = runtimeResponseSchema;

export const stopRuntimeRequestSchema = z
  .object({
    locator: runtimeLocatorSchema,
    reason: z.string().min(1).max(500).optional(),
  })
  .strict();
export const stopRuntimeResponseSchema = runtimeResponseSchema;

export const destroyRuntimeRequestSchema = z
  .object({
    locator: runtimeLocatorSchema,
    reason: z.string().min(1).max(500).optional(),
  })
  .strict();
export const destroyRuntimeResponseSchema = successSchema;

export const statusRuntimeRequestSchema = z.object({ locator: runtimeLocatorSchema }).strict();
export const statusRuntimeResponseSchema = runtimeResponseSchema;

export const execRuntimeRequestSchema = z
  .object({
    locator: runtimeLocatorSchema,
    argv: z.array(argvEntrySchema).min(1).max(256),
    cwd: runtimePathSchema
      .refine((path) => path.startsWith("/"), "cwd must be absolute")
      .optional(),
    timeoutMs: z.number().int().min(100).max(120_000),
  })
  .strict();
export const execRuntimeResponseSchema = z
  .object({
    ok: z.boolean(),
    stdout: z.string().max(1_000_000),
    stderr: z.string().max(1_000_000),
    exitCode: z.number().int().nullable(),
    timedOut: z.boolean(),
  })
  .strict();

export const logsRuntimeRequestSchema = z
  .object({
    locator: runtimeLocatorSchema,
    cursor: z.string().min(1).max(500).optional(),
    limit: z.number().int().min(1).max(1_000).default(200),
    follow: z.boolean().default(false),
  })
  .strict();
export const runtimeLogEntrySchema = z
  .object({
    cursor: z.string().min(1).max(500),
    timestamp: z.string().datetime(),
    level: z.enum(["stdout", "stderr", "system"]),
    message: z.string().max(100_000),
  })
  .strict();
export const logsRuntimeResponseSchema = z
  .object({
    entries: z.array(runtimeLogEntrySchema).max(1_000),
    nextCursor: z.string().min(1).max(500).nullable(),
  })
  .strict();

export const runtimeFileSchema = z
  .object({
    path: relativeRuntimeFilePathSchema,
    content: z.string().max(10 * 1024 * 1024),
    sha256: sha256Schema,
  })
  .strict();
export const filesRuntimeRequestSchema = z
  .object({
    locator: runtimeLocatorSchema,
    artifactRevision: revisionSchema,
    files: z.array(runtimeFileSchema).max(10_000),
  })
  .strict();
export const filesRuntimeResponseSchema = z
  .object({
    ok: z.literal(true),
    artifactRevision: revisionSchema,
    filesWritten: z.number().int().nonnegative(),
  })
  .strict();

export const restoreRuntimeRequestSchema = z
  .object({
    locator: runtimeLocatorSchema,
    artifactRevision: revisionSchema,
    artifactSha256: sha256Schema,
  })
  .strict();
export const restoreRuntimeResponseSchema = z
  .object({
    ok: z.literal(true),
    artifactRevision: revisionSchema,
    filesRestored: z.number().int().nonnegative(),
  })
  .strict();

const environmentNameSchema = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
  .max(200);
export const environmentRuntimeRequestSchema = z
  .object({
    locator: runtimeLocatorSchema,
    classification: z.literal("non-secret"),
    variables: z.record(environmentNameSchema, z.string().max(100_000)),
    restart: z.boolean(),
  })
  .strict();
export const environmentRuntimeResponseSchema = runtimeResponseSchema;

export const activateRouteRequestSchema = z
  .object({
    route: routeRecordSchema,
    expectedPreviousManifestRevision: revisionSchema.nullable(),
  })
  .strict();
export const activateRouteResponseSchema = z
  .object({
    ok: z.literal(true),
    route: routeRecordSchema,
  })
  .strict();

export const deactivateRouteRequestSchema = z
  .object({
    hostname: publishedHostnameSchema,
    expectedManifestRevision: revisionSchema,
    expectedSandboxIdentity: z.string().min(1).max(200),
  })
  .strict();
export const deactivateRouteResponseSchema = z
  .object({
    ok: z.literal(true),
    hostname: publishedHostnameSchema,
  })
  .strict();

/**
 * Single registry for Worker and API implementations. Each endpoint receives
 * already-combined path/query/body input so the same strict schema is applied
 * on both sides of the transport.
 */
export const controlEndpointSchemas = {
  version: { request: versionRequestSchema, response: versionResponseSchema },
  ensure: { request: ensureRuntimeRequestSchema, response: ensureRuntimeResponseSchema },
  start: { request: startRuntimeRequestSchema, response: startRuntimeResponseSchema },
  stop: { request: stopRuntimeRequestSchema, response: stopRuntimeResponseSchema },
  destroy: { request: destroyRuntimeRequestSchema, response: destroyRuntimeResponseSchema },
  status: { request: statusRuntimeRequestSchema, response: statusRuntimeResponseSchema },
  exec: { request: execRuntimeRequestSchema, response: execRuntimeResponseSchema },
  logs: { request: logsRuntimeRequestSchema, response: logsRuntimeResponseSchema },
  files: { request: filesRuntimeRequestSchema, response: filesRuntimeResponseSchema },
  restore: { request: restoreRuntimeRequestSchema, response: restoreRuntimeResponseSchema },
  environment: {
    request: environmentRuntimeRequestSchema,
    response: environmentRuntimeResponseSchema,
  },
  routeActivate: { request: activateRouteRequestSchema, response: activateRouteResponseSchema },
  routeDeactivate: {
    request: deactivateRouteRequestSchema,
    response: deactivateRouteResponseSchema,
  },
} as const;

export const CONTROL_API_PREFIX = "/_nabuflow/control/v1" as const;

/** HTTP routing metadata shared by the API client and future Worker router. */
export const controlEndpointContracts = {
  version: { method: "GET", path: `${CONTROL_API_PREFIX}/version` },
  ensure: { method: "PUT", path: `${CONTROL_API_PREFIX}/runtimes/:projectId/:role/:slot` },
  start: { method: "POST", path: `${CONTROL_API_PREFIX}/runtimes/:projectId/:role/:slot/start` },
  stop: { method: "POST", path: `${CONTROL_API_PREFIX}/runtimes/:projectId/:role/:slot/stop` },
  destroy: { method: "DELETE", path: `${CONTROL_API_PREFIX}/runtimes/:projectId/:role/:slot` },
  status: { method: "GET", path: `${CONTROL_API_PREFIX}/runtimes/:projectId/:role/:slot` },
  exec: { method: "POST", path: `${CONTROL_API_PREFIX}/runtimes/:projectId/:role/:slot/exec` },
  logs: { method: "GET", path: `${CONTROL_API_PREFIX}/runtimes/:projectId/:role/:slot/logs` },
  files: { method: "PUT", path: `${CONTROL_API_PREFIX}/runtimes/:projectId/:role/:slot/files` },
  restore: {
    method: "POST",
    path: `${CONTROL_API_PREFIX}/runtimes/:projectId/:role/:slot/restore`,
  },
  environment: {
    method: "PUT",
    path: `${CONTROL_API_PREFIX}/runtimes/:projectId/:role/:slot/environment`,
  },
  routeActivate: { method: "POST", path: `${CONTROL_API_PREFIX}/routes/:hostname/activate` },
  routeDeactivate: { method: "DELETE", path: `${CONTROL_API_PREFIX}/routes/:hostname` },
} as const satisfies Record<keyof typeof controlEndpointSchemas, { method: string; path: string }>;

export type EnsureRuntimeRequest = z.infer<typeof ensureRuntimeRequestSchema>;
export type StartRuntimeRequest = z.infer<typeof startRuntimeRequestSchema>;
export type StopRuntimeRequest = z.infer<typeof stopRuntimeRequestSchema>;
export type DestroyRuntimeRequest = z.infer<typeof destroyRuntimeRequestSchema>;
export type StatusRuntimeRequest = z.infer<typeof statusRuntimeRequestSchema>;
export type ExecRuntimeRequest = z.infer<typeof execRuntimeRequestSchema>;
export type LogsRuntimeRequest = z.infer<typeof logsRuntimeRequestSchema>;
export type FilesRuntimeRequest = z.infer<typeof filesRuntimeRequestSchema>;
export type RestoreRuntimeRequest = z.infer<typeof restoreRuntimeRequestSchema>;
export type EnvironmentRuntimeRequest = z.infer<typeof environmentRuntimeRequestSchema>;
export type ActivateRouteRequest = z.infer<typeof activateRouteRequestSchema>;
export type DeactivateRouteRequest = z.infer<typeof deactivateRouteRequestSchema>;
export type ControlErrorResponse = z.infer<typeof controlErrorResponseSchema>;
export type VersionRequest = z.infer<typeof versionRequestSchema>;
export type VersionResponse = z.infer<typeof versionResponseSchema>;
export type EnsureRuntimeResponse = z.infer<typeof ensureRuntimeResponseSchema>;
export type StartRuntimeResponse = z.infer<typeof startRuntimeResponseSchema>;
export type StopRuntimeResponse = z.infer<typeof stopRuntimeResponseSchema>;
export type DestroyRuntimeResponse = z.infer<typeof destroyRuntimeResponseSchema>;
export type StatusRuntimeResponse = z.infer<typeof statusRuntimeResponseSchema>;
export type ExecRuntimeResponse = z.infer<typeof execRuntimeResponseSchema>;
export type LogsRuntimeResponse = z.infer<typeof logsRuntimeResponseSchema>;
export type FilesRuntimeResponse = z.infer<typeof filesRuntimeResponseSchema>;
export type RestoreRuntimeResponse = z.infer<typeof restoreRuntimeResponseSchema>;
export type EnvironmentRuntimeResponse = z.infer<typeof environmentRuntimeResponseSchema>;
export type ActivateRouteResponse = z.infer<typeof activateRouteResponseSchema>;
export type DeactivateRouteResponse = z.infer<typeof deactivateRouteResponseSchema>;
