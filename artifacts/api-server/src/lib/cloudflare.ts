/**
 * Cloudflare for SaaS — typed API client wrapper.
 *
 * All methods gracefully no-op (return null/false/empty) when CF_ZONE_ID or
 * CF_API_TOKEN are not set, mirroring the container.ts degradation pattern.
 *
 * Required env vars:
 *   CF_ZONE_ID     — Cloudflare zone ID for mustaflow.app
 *   CF_API_TOKEN   — API token with custom_hostnames:edit permission
 *   CLOUDFLARE_SAAS_FALLBACK_ORIGIN — fallback origin hostname (e.g. api.mustaflow.app)
 */

import { logger } from "./logger";

const CF_API_BASE = "https://api.cloudflare.com/client/v4";

export function cfEnabled(): boolean {
  return Boolean(process.env.CF_ZONE_ID && process.env.CF_API_TOKEN);
}

function zoneId(): string {
  return process.env.CF_ZONE_ID!;
}

function apiToken(): string {
  return process.env.CF_API_TOKEN!;
}

function jsonHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${apiToken()}`,
    "Content-Type": "application/json",
  };
}

function readHeaders(): Record<string, string> {
  return { Authorization: `Bearer ${apiToken()}` };
}

// ── Cloudflare type definitions ───────────────────────────────────────────────

export type CfSslStatus =
  | "pending_validation"
  | "pending_issuance"
  | "pending_deployment"
  | "initializing"
  | "active"
  | "expired_certificate"
  | "blocked"
  | "deactivated"
  | "pending_blocked_validation"
  | "validation_timed_out"
  | string;

export interface CfSslDetail {
  status: CfSslStatus;
  /** ISO-8601 date string — populated only after the cert is issued. */
  expires_on?: string;
  issuer?: string;
  type?: string;
  method?: string;
}

export interface CfCustomHostname {
  id: string;
  hostname: string;
  ssl: CfSslDetail;
  /** Hostname-level status (separate from ssl.status). */
  status?: string;
  created_at?: string;
}

interface CfApiResult<T> {
  success: boolean;
  result?: T;
  errors?: Array<{ code: number; message: string }>;
}

interface CfListResult<T> {
  success: boolean;
  result?: T[];
  result_info?: { count: number; page: number; per_page: number; total_count: number };
  errors?: Array<{ code: number; message: string }>;
}

// ── Status mapping ────────────────────────────────────────────────────────────

/**
 * Map a Cloudflare ssl.status string → our internal sslStatus enum.
 * Statuses are ordered by severity so UI can pick appropriate styling.
 */
export function mapCfSslStatus(
  cfStatus: string | undefined,
): "pending" | "provisioning" | "active" | "expiring_soon" | "expired" | "failed" {
  switch (cfStatus) {
    case "active":
      return "active";
    case "pending_validation":
    case "pending_issuance":
    case "pending_deployment":
    case "initializing":
      return "provisioning";
    case "expired_certificate":
      return "expired";
    case "blocked":
    case "deactivated":
    case "pending_blocked_validation":
    case "validation_timed_out":
      return "failed";
    default:
      return "provisioning";
  }
}

// ── API methods ───────────────────────────────────────────────────────────────

/**
 * Create a new Cloudflare custom hostname (SSL for SaaS).
 *
 * Uses HTTP DV validation — Cloudflare auto-renews the cert as long as the
 * CNAME / A record keeps pointing to us.
 *
 * Returns the created hostname object, or null when CF is not configured or
 * the call fails.
 */
export async function createCustomHostname(hostname: string): Promise<CfCustomHostname | null> {
  if (!cfEnabled()) return null;
  try {
    const resp = await fetch(`${CF_API_BASE}/zones/${zoneId()}/custom_hostnames`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({
        hostname,
        ssl: {
          method: "http",
          type: "dv",
          settings: { min_tls_version: "1.2", http2: "on" },
        },
      }),
    });
    const json = (await resp.json()) as CfApiResult<CfCustomHostname>;
    if (!json.success || !json.result) {
      const msg = json.errors?.map((e) => e.message).join("; ") ?? "Unknown CF error";
      logger.warn({ hostname, msg }, "CF createCustomHostname failed");
      return null;
    }
    return json.result;
  } catch (err) {
    logger.warn({ err, hostname }, "CF createCustomHostname threw");
    return null;
  }
}

/**
 * Fetch the current state of a Cloudflare custom hostname by its CF ID.
 * Returns null when CF is not configured or on network / API error.
 */
export async function getCustomHostname(cfHostnameId: string): Promise<CfCustomHostname | null> {
  if (!cfEnabled()) return null;
  try {
    const resp = await fetch(`${CF_API_BASE}/zones/${zoneId()}/custom_hostnames/${cfHostnameId}`, {
      headers: readHeaders(),
    });
    const json = (await resp.json()) as CfApiResult<CfCustomHostname>;
    if (!json.success || !json.result) return null;
    return json.result;
  } catch (err) {
    logger.warn({ err, cfHostnameId }, "CF getCustomHostname threw");
    return null;
  }
}

/**
 * Delete a Cloudflare custom hostname by its CF ID.
 * Returns true on success, false when not configured or on error.
 */
export async function deleteCustomHostname(cfHostnameId: string): Promise<boolean> {
  if (!cfEnabled()) return false;
  try {
    const resp = await fetch(`${CF_API_BASE}/zones/${zoneId()}/custom_hostnames/${cfHostnameId}`, {
      method: "DELETE",
      headers: readHeaders(),
    });
    return resp.ok;
  } catch (err) {
    logger.warn({ err, cfHostnameId }, "CF deleteCustomHostname threw");
    return false;
  }
}

/**
 * List all Cloudflare custom hostnames for the zone, paginating automatically.
 * Returns an empty array when CF is not configured.
 */
export async function listCustomHostnames(): Promise<CfCustomHostname[]> {
  if (!cfEnabled()) return [];
  const results: CfCustomHostname[] = [];
  let page = 1;
  const perPage = 100;
  while (true) {
    try {
      const resp = await fetch(
        `${CF_API_BASE}/zones/${zoneId()}/custom_hostnames?page=${page}&per_page=${perPage}`,
        { headers: readHeaders() },
      );
      const json = (await resp.json()) as CfListResult<CfCustomHostname>;
      if (!json.success || !json.result) break;
      results.push(...json.result);
      const info = json.result_info;
      if (!info || page * perPage >= info.total_count) break;
      page++;
    } catch (err) {
      logger.warn({ err, page }, "CF listCustomHostnames threw");
      break;
    }
  }
  return results;
}
