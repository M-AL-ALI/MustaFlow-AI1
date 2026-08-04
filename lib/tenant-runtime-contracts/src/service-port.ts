import { z } from "zod";
import {
  CLOUDFLARE_RESERVED_SERVICE_PORT,
  MAX_TENANT_SERVICE_PORT,
  MIN_TENANT_SERVICE_PORT,
} from "./constants";

export const tenantServicePortSchema = z
  .number()
  .int()
  .min(MIN_TENANT_SERVICE_PORT)
  .max(MAX_TENANT_SERVICE_PORT)
  .refine((port) => port !== CLOUDFLARE_RESERVED_SERVICE_PORT, {
    message: `Port ${CLOUDFLARE_RESERVED_SERVICE_PORT} is reserved by the Cloudflare Sandbox control service`,
  });

export type TenantServicePort = z.infer<typeof tenantServicePortSchema>;
