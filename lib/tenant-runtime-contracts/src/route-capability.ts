import { z } from "zod";
import { HTTP_METHODS, RUNTIME_ROLES, RUNTIME_SLOTS, slotIsValidForRole } from "./constants";
import { parseRuntimeIdentity } from "./runtime-identity";
import { tenantServicePortSchema } from "./service-port";

const hostnameSchema = z
  .string()
  .min(1)
  .max(253)
  .regex(
    /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/,
    "Expected a normalized lowercase ASCII hostname without a port",
  );

const runtimeRoleSchema = z.enum(RUNTIME_ROLES);
const runtimeSlotSchema = z.enum(RUNTIME_SLOTS);

export const routeRecordSchema = z
  .object({
    hostname: hostnameSchema,
    projectId: z.number().int().positive().safe(),
    role: runtimeRoleSchema,
    activeSlot: runtimeSlotSchema,
    manifestRevision: z.string().min(1).max(200),
    servicePort: tenantServicePortSchema,
    sandboxIdentity: z.string().min(1).max(200),
  })
  .strict()
  .superRefine((record, context) => {
    if (!slotIsValidForRole(record.role, record.activeSlot)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["activeSlot"],
        message: `Slot ${record.activeSlot} is not valid for role ${record.role}`,
      });
    }

    try {
      const identity = parseRuntimeIdentity(record.sandboxIdentity);
      if (
        identity.projectId !== record.projectId ||
        identity.role !== record.role ||
        identity.slot !== record.activeSlot
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["sandboxIdentity"],
          message: "Sandbox identity does not match the route record",
        });
      }
    } catch (error) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["sandboxIdentity"],
        message: error instanceof Error ? error.message : "Malformed sandbox identity",
      });
    }
  });

export type RouteRecord = z.infer<typeof routeRecordSchema>;

const allowedPathSchema = z
  .object({
    match: z.enum(["exact", "prefix"]),
    path: z
      .string()
      .min(1)
      .max(500)
      .regex(/^\/(?!\/)/, "Path must be absolute")
      .refine(
        (path) => !/[\r\n?#]/.test(path),
        "Path cannot include a query, fragment, or newline",
      ),
  })
  .strict();

const credentialInjectionSchema = z.discriminatedUnion("location", [
  z
    .object({
      location: z.literal("authorization-header"),
      scheme: z.string().min(1).max(40).default("Bearer"),
    })
    .strict(),
  z
    .object({
      location: z.literal("header"),
      headerName: z
        .string()
        .min(1)
        .max(100)
        .regex(/^[A-Za-z0-9-]+$/, "Invalid HTTP header name"),
      prefix: z.string().max(100).default(""),
    })
    .strict(),
  z
    .object({
      location: z.literal("query"),
      parameterName: z
        .string()
        .min(1)
        .max(100)
        .regex(/^[A-Za-z_][A-Za-z0-9_.-]*$/),
    })
    .strict(),
  z.object({ location: z.literal("worker-binding") }).strict(),
]);

const capabilityLimitsSchema = z
  .object({
    timeoutMs: z.number().int().min(100).max(120_000),
    maxRequestBytes: z
      .number()
      .int()
      .positive()
      .max(100 * 1024 * 1024),
    maxResponseBytes: z
      .number()
      .int()
      .positive()
      .max(100 * 1024 * 1024),
    maxRequestsPerMinute: z.number().int().positive().max(100_000),
    maxConcurrent: z.number().int().positive().max(1_000),
  })
  .strict();

export const capabilityDefinitionSchema = z
  .object({
    name: z
      .string()
      .min(1)
      .max(100)
      .regex(/^[a-z][a-z0-9-]*$/),
    provider: z
      .string()
      .min(1)
      .max(100)
      .regex(/^[a-z][a-z0-9-]*$/),
    allowedMethods: z.array(z.enum(HTTP_METHODS)).min(1).max(7),
    allowedPaths: z.array(allowedPathSchema).min(1).max(100),
    injection: credentialInjectionSchema,
    limits: capabilityLimitsSchema,
  })
  .strict()
  .superRefine((capability, context) => {
    if (new Set(capability.allowedMethods).size !== capability.allowedMethods.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["allowedMethods"],
        message: "Allowed methods must be unique",
      });
    }

    const serializedPaths = capability.allowedPaths.map((rule) => `${rule.match}:${rule.path}`);
    if (new Set(serializedPaths).size !== serializedPaths.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["allowedPaths"],
        message: "Allowed path rules must be unique",
      });
    }
  });

export type CapabilityDefinition = z.infer<typeof capabilityDefinitionSchema>;
