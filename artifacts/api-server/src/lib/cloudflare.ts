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

// ── DNS Record type definitions ───────────────────────────────────────────────

/** Cloudflare DNS record as returned by the API. */
export interface CfDnsRecord {
  id: string;
  type: string;
  name: string;
  /** Main content value: IP address for A/AAAA, hostname for CNAME/NS/MX, text for TXT. */
  content?: string;
  /** MX / SRV priority. */
  priority?: number;
  /** TTL in seconds; 1 = auto. */
  ttl: number;
  /** Whether Cloudflare proxies this record (orange cloud). */
  proxied?: boolean;
  /** SRV / CAA structured data. */
  data?: Record<string, unknown>;
  comment?: string;
  modified_on?: string;
  created_on?: string;
  zone_name?: string;
}

/** Input for creating or updating a DNS record. */
export interface CfDnsRecordInput {
  type: string;
  name: string;
  content?: string;
  priority?: number;
  ttl?: number;
  proxied?: boolean;
  data?: Record<string, unknown>;
  comment?: string;
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

// ── Custom Hostname API methods ────────────────────────────────────────────────

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

// ── DNS Record API methods ────────────────────────────────────────────────────

/**
 * List DNS records for a domain namespace (apex + all subdomains).
 *
 * When `domainSuffix` is provided, fetches all zone records and filters
 * client-side to records whose name equals the suffix OR ends with ".suffix".
 * This correctly returns apex records, MX, SPF/TXT, DKIM selectors, _dmarc,
 * and any other subdomain records — unlike the Cloudflare `name=` exact-match
 * filter, which only returns the apex row.
 *
 * Pass domainSuffix = null to list all zone records (admin use only).
 * Returns an empty array when CF is not configured.
 */
export async function listDnsRecords(domainSuffix: string | null = null): Promise<CfDnsRecord[]> {
  if (!cfEnabled()) return [];
  const results: CfDnsRecord[] = [];
  let page = 1;
  const perPage = 100;
  while (true) {
    try {
      const resp = await fetch(
        `${CF_API_BASE}/zones/${zoneId()}/dns_records?page=${page}&per_page=${perPage}`,
        { headers: readHeaders() },
      );
      const json = (await resp.json()) as CfListResult<CfDnsRecord>;
      if (!json.success || !json.result) break;
      results.push(...json.result);
      const info = json.result_info;
      if (!info || page * perPage >= info.total_count) break;
      page++;
    } catch (err) {
      logger.warn({ err, domainSuffix, page }, "CF listDnsRecords threw");
      break;
    }
  }

  if (!domainSuffix) return results;

  // Filter to records within the domain namespace: apex + all subdomains.
  const suffix = domainSuffix.toLowerCase();
  return results.filter((r) => {
    const name = r.name.toLowerCase().replace(/\.$/, ""); // strip trailing dot
    return name === suffix || name.endsWith(`.${suffix}`);
  });
}

/**
 * Create a DNS record in the Cloudflare zone.
 * Returns the created record or null on failure / when CF is not configured.
 */
export async function createDnsRecord(input: CfDnsRecordInput): Promise<CfDnsRecord | null> {
  if (!cfEnabled()) return null;
  try {
    const resp = await fetch(`${CF_API_BASE}/zones/${zoneId()}/dns_records`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify(input),
    });
    const json = (await resp.json()) as CfApiResult<CfDnsRecord>;
    if (!json.success || !json.result) {
      const msg = json.errors?.map((e) => e.message).join("; ") ?? "Unknown CF error";
      logger.warn({ input, msg }, "CF createDnsRecord failed");
      return null;
    }
    return json.result;
  } catch (err) {
    logger.warn({ err, input }, "CF createDnsRecord threw");
    return null;
  }
}

/**
 * Update an existing DNS record (PATCH — partial update).
 * Returns the updated record or null on failure.
 */
export async function updateDnsRecord(
  recordId: string,
  input: Partial<CfDnsRecordInput>,
): Promise<CfDnsRecord | null> {
  if (!cfEnabled()) return null;
  try {
    const resp = await fetch(`${CF_API_BASE}/zones/${zoneId()}/dns_records/${recordId}`, {
      method: "PATCH",
      headers: jsonHeaders(),
      body: JSON.stringify(input),
    });
    const json = (await resp.json()) as CfApiResult<CfDnsRecord>;
    if (!json.success || !json.result) {
      const msg = json.errors?.map((e) => e.message).join("; ") ?? "Unknown CF error";
      logger.warn({ recordId, input, msg }, "CF updateDnsRecord failed");
      return null;
    }
    return json.result;
  } catch (err) {
    logger.warn({ err, recordId }, "CF updateDnsRecord threw");
    return null;
  }
}

/**
 * Delete a DNS record from the zone.
 * Returns true on success, false when not configured or on error.
 */
export async function deleteDnsRecord(recordId: string): Promise<boolean> {
  if (!cfEnabled()) return false;
  try {
    const resp = await fetch(`${CF_API_BASE}/zones/${zoneId()}/dns_records/${recordId}`, {
      method: "DELETE",
      headers: readHeaders(),
    });
    if (!resp.ok) {
      logger.warn({ recordId, status: resp.status }, "CF deleteDnsRecord non-ok status");
      return false;
    }
    return true;
  } catch (err) {
    logger.warn({ err, recordId }, "CF deleteDnsRecord threw");
    return false;
  }
}

/**
 * Compute a dry-run diff: what zone records would change if the proposed
 * changes were applied. Fetches current records matching each name+type,
 * then returns a before/after diff without touching Cloudflare.
 */
export async function dryRunDnsChanges(
  proposed: CfDnsRecordInput[],
  hostname: string,
): Promise<
  Array<{
    action: "create" | "update" | "unchanged";
    name: string;
    type: string;
    before: CfDnsRecord | null;
    after: CfDnsRecordInput;
  }>
> {
  if (!cfEnabled()) return [];
  const current = await listDnsRecords(hostname);
  const currentByTypeAndName = new Map<string, CfDnsRecord>();
  for (const r of current) {
    currentByTypeAndName.set(`${r.type}:${r.name}`, r);
  }

  return proposed.map((p) => {
    const key = `${p.type}:${p.name}`;
    const before = currentByTypeAndName.get(key) ?? null;
    if (!before) {
      return { action: "create", name: p.name, type: p.type, before: null, after: p };
    }
    const changed =
      before.content !== p.content ||
      before.priority !== p.priority ||
      before.ttl !== (p.ttl ?? before.ttl) ||
      (before.proxied ?? false) !== (p.proxied ?? before.proxied ?? false) ||
      JSON.stringify(before.data ?? null) !== JSON.stringify(p.data ?? null);
    return {
      action: changed ? "update" : "unchanged",
      name: p.name,
      type: p.type,
      before,
      after: p,
    };
  });
}

// ── BYO Certificate upload ────────────────────────────────────────────────────

/**
 * Upload a BYO TLS certificate to Cloudflare SSL for SaaS for a custom hostname.
 * This switches the custom hostname from CF-issued DV cert to a user-supplied cert.
 *
 * Returns true on success. When CF is not configured, returns false (graceful no-op).
 */
export async function uploadCustomCert(
  cfHostnameId: string,
  certificate: string,
  privateKey: string,
): Promise<boolean> {
  if (!cfEnabled()) return false;
  try {
    const resp = await fetch(`${CF_API_BASE}/zones/${zoneId()}/custom_hostnames/${cfHostnameId}`, {
      method: "PATCH",
      headers: jsonHeaders(),
      body: JSON.stringify({
        ssl: {
          method: "http",
          type: "dv",
          custom_certificate: certificate,
          custom_key: privateKey,
          settings: { min_tls_version: "1.2", http2: "on" },
        },
      }),
    });
    const json = (await resp.json()) as CfApiResult<CfCustomHostname>;
    if (!json.success) {
      const msg = json.errors?.map((e) => e.message).join("; ") ?? "Unknown CF error";
      logger.warn({ cfHostnameId, msg }, "CF uploadCustomCert failed");
      return false;
    }
    return true;
  } catch (err) {
    logger.warn({ err, cfHostnameId }, "CF uploadCustomCert threw");
    return false;
  }
}

/**
 * Remove a BYO cert from a Cloudflare custom hostname, reverting to CF-issued DV cert.
 * Returns true on success.
 */
export async function removeCustomCert(cfHostnameId: string): Promise<boolean> {
  if (!cfEnabled()) return false;
  try {
    const resp = await fetch(`${CF_API_BASE}/zones/${zoneId()}/custom_hostnames/${cfHostnameId}`, {
      method: "PATCH",
      headers: jsonHeaders(),
      body: JSON.stringify({
        ssl: {
          method: "http",
          type: "dv",
          custom_certificate: null,
          custom_key: null,
        },
      }),
    });
    const json = (await resp.json()) as CfApiResult<CfCustomHostname>;
    if (!json.success) {
      const msg = json.errors?.map((e) => e.message).join("; ") ?? "Unknown CF error";
      logger.warn({ cfHostnameId, msg }, "CF removeCustomCert failed");
      return false;
    }
    return true;
  } catch (err) {
    logger.warn({ err, cfHostnameId }, "CF removeCustomCert threw");
    return false;
  }
}
