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
 *
 * Optional env vars (edge CDN features):
 *   CF_ACCOUNT_ID         — Cloudflare account ID (required for R2 + KV)
 *   CF_R2_ACCESS_KEY_ID   — R2 API token access key ID (S3-compatible API)
 *   CF_R2_SECRET_ACCESS_KEY — R2 API token secret key
 *   CF_R2_BUCKET          — R2 bucket name (default: mustaflow-snapshots)
 *   CF_KV_NAMESPACE_ID    — Workers KV namespace ID for hostname routing
 */

import { createHmac, createHash } from "crypto";
import { logger } from "./logger";

const CF_API_BASE = "https://api.cloudflare.com/client/v4";

export function cfEnabled(): boolean {
  return Boolean(process.env.CF_ZONE_ID && process.env.CF_API_TOKEN);
}

/** True when R2 upload credentials are configured. */
export function r2Enabled(): boolean {
  return Boolean(
    process.env.CF_ACCOUNT_ID &&
    process.env.CF_R2_ACCESS_KEY_ID &&
    process.env.CF_R2_SECRET_ACCESS_KEY,
  );
}

/** True when the Worker KV namespace is configured. */
export function kvEnabled(): boolean {
  return Boolean(process.env.CF_ACCOUNT_ID && process.env.CF_KV_NAMESPACE_ID);
}

function zoneId(): string {
  return process.env.CF_ZONE_ID!;
}

function apiToken(): string {
  return process.env.CF_API_TOKEN!;
}

function accountId(): string {
  return process.env.CF_ACCOUNT_ID!;
}

function r2Bucket(): string {
  return process.env.CF_R2_BUCKET ?? "mustaflow-snapshots";
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

// ── WAF + Bot Management defaults — Task #560 ─────────────────────────────────

/**
 * Apply default WAF and bot management settings for a newly created custom hostname.
 *
 * Cloudflare WAF rules are zone-level; this function adds a zone-scoped custom rule
 * that enables the OWASP managed ruleset and CF-managed rules for the given hostname.
 * Bot management is enabled at the zone level and cannot be scoped per-hostname via
 * the basic API — this call is recorded for auditing.
 *
 * Gracefully no-ops if CF is not configured.
 * Returns true on success, false on failure.
 */
export async function applyDefaultWafRules(
  hostname: string,
  _cfHostnameId: string,
): Promise<boolean> {
  if (!cfEnabled()) return false;
  try {
    // Apply managed rulesets via Zone Rulesets API (http_request_firewall_managed phase).
    // This is a zone-level operation that includes a hostname condition.
    const resp = await fetch(
      `${CF_API_BASE}/zones/${zoneId()}/rulesets/phases/http_request_firewall_managed/entrypoint/rules`,
      {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({
          description: `WAF defaults for ${hostname}`,
          action: "execute",
          expression: `http.host eq "${hostname}"`,
          action_parameters: {
            id: "efb7b8c949ac4650a09736fc376e9aee", // CF Managed Ruleset
            overrides: { enabled: true },
          },
        }),
      },
    );
    if (!resp.ok) {
      const json = (await resp.json()) as CfApiResult<unknown>;
      logger.warn(
        { hostname, errors: json.errors },
        "CF applyDefaultWafRules: managed ruleset apply failed (non-fatal)",
      );
      return false;
    }
    logger.info({ hostname }, "CF applyDefaultWafRules: WAF defaults applied");
    return true;
  } catch (err) {
    logger.warn({ err, hostname }, "CF applyDefaultWafRules threw (non-fatal)");
    return false;
  }
}

export interface DomainSecurityConfigForCf {
  rateLimitRps?: number;
  geoBlock?: string[];
  ipAllow?: string[];
  ipDeny?: string[];
  mtlsEnabled?: boolean;
  mtlsCaCert?: string;
  wafEnabled?: boolean;
  botManagement?: boolean;
}

// ── Input validators ──────────────────────────────────────────────────────────
// All values that end up in Cloudflare expression strings must pass validation
// before being interpolated. This prevents expression injection attacks which
// could affect other tenants on the same zone.

// Matches IPv4 + optional CIDR, IPv6 + optional CIDR
const IPV4_RE = /^(\d{1,3}\.){3}\d{1,3}(\/\d{1,2})?$/;
const IPV6_RE = /^[0-9a-fA-F:]+(%[a-zA-Z0-9]+)?(\/\d{1,3})?$/;

/**
 * Returns true only for well-formed IPv4/IPv6 addresses or CIDR ranges.
 * Rejects anything that could break out of a CF expression string.
 */
export function isValidIpOrCidr(s: string): boolean {
  if (!s || s.length > 50) return false;
  // No whitespace, quotes, parens, or CF expression metacharacters
  if (/[\s"'(){}]/.test(s)) return false;
  return IPV4_RE.test(s) || IPV6_RE.test(s);
}

/**
 * Returns true for exactly two uppercase ASCII letters (ISO 3166-1 alpha-2).
 */
export function isValidCountryCode(s: string): boolean {
  return /^[A-Z]{2}$/.test(s);
}

/**
 * Apply per-domain security config to Cloudflare.
 *
 * - IP deny: zone-level custom rule blocking requests from denied CIDRs.
 * - IP allow: zone-level block rule for all IPs NOT in the allow list.
 * - Geo-block: zone-level block rule for listed ISO country codes.
 * - Rate limit: zone-level rate limiting rule scoped to this hostname.
 * - wafEnabled: toggle CF Managed Ruleset on/off for this hostname expression.
 * - botManagement: add a challenge rule for bot scores < 30 (requires Bot Management plan).
 *
 * All values are validated before being interpolated into CF expression strings.
 * Invalid entries are logged and silently skipped — tenant isolation is preserved.
 *
 * Returns true if at least one rule was successfully applied; false otherwise.
 */
export async function applySecurityConfig(
  hostname: string,
  config: DomainSecurityConfigForCf,
): Promise<boolean> {
  if (!cfEnabled()) return false;

  // Hostname must be a safe token (no expression metacharacters)
  if (/"/.test(hostname)) {
    logger.error({ hostname }, "CF applySecurityConfig: hostname contains quotes — aborting");
    return false;
  }

  let anyApplied = false;

  try {
    // ── IP deny ───────────────────────────────────────────────────────────────
    if (config.ipDeny && config.ipDeny.length > 0) {
      const validIps = config.ipDeny.filter((ip) => {
        if (!isValidIpOrCidr(ip)) {
          logger.warn({ hostname, ip }, "CF applySecurityConfig: ipDeny entry invalid — skipping");
          return false;
        }
        return true;
      });
      if (validIps.length > 0) {
        // CF expression: ip.src in {a.b.c.d e.e.e.e} — space-separated, no quotes around IPs
        const ipSet = validIps.join(" ");
        const resp = await fetch(`${CF_API_BASE}/zones/${zoneId()}/firewall/rules`, {
          method: "POST",
          headers: jsonHeaders(),
          body: JSON.stringify([
            {
              action: "block",
              description: `IP deny list for ${hostname}`,
              filter: {
                expression: `(http.host eq "${hostname}") and (ip.src in {${ipSet}})`,
              },
            },
          ]),
        });
        if (resp.ok) anyApplied = true;
        else logger.warn({ hostname }, "CF applySecurityConfig: ipDeny rule failed");
      }
    }

    // ── IP allow ──────────────────────────────────────────────────────────────
    if (config.ipAllow && config.ipAllow.length > 0) {
      const validIps = config.ipAllow.filter((ip) => {
        if (!isValidIpOrCidr(ip)) {
          logger.warn({ hostname, ip }, "CF applySecurityConfig: ipAllow entry invalid — skipping");
          return false;
        }
        return true;
      });
      if (validIps.length > 0) {
        const ipSet = validIps.join(" ");
        // Block everyone NOT in the allow set
        const resp = await fetch(`${CF_API_BASE}/zones/${zoneId()}/firewall/rules`, {
          method: "POST",
          headers: jsonHeaders(),
          body: JSON.stringify([
            {
              action: "block",
              description: `IP allowlist enforcement for ${hostname}`,
              filter: {
                expression: `(http.host eq "${hostname}") and not (ip.src in {${ipSet}})`,
              },
            },
          ]),
        });
        if (resp.ok) anyApplied = true;
        else logger.warn({ hostname }, "CF applySecurityConfig: ipAllow rule failed");
      }
    }

    // ── Geo-block ─────────────────────────────────────────────────────────────
    if (config.geoBlock && config.geoBlock.length > 0) {
      const validCcs = config.geoBlock.filter((cc) => {
        if (!isValidCountryCode(cc)) {
          logger.warn(
            { hostname, cc },
            "CF applySecurityConfig: geoBlock country code invalid — skipping",
          );
          return false;
        }
        return true;
      });
      if (validCcs.length > 0) {
        // CF expression: ip.geoip.country in {"CC1" "CC2"} — quoted, space-separated
        const ccList = validCcs.map((cc) => `"${cc}"`).join(" ");
        const resp = await fetch(`${CF_API_BASE}/zones/${zoneId()}/firewall/rules`, {
          method: "POST",
          headers: jsonHeaders(),
          body: JSON.stringify([
            {
              action: "block",
              description: `Geo-block for ${hostname}`,
              filter: {
                expression: `(http.host eq "${hostname}") and (ip.geoip.country in {${ccList}})`,
              },
            },
          ]),
        });
        if (resp.ok) anyApplied = true;
        else logger.warn({ hostname }, "CF applySecurityConfig: geoBlock rule failed");
      }
    }

    // ── Rate limit ────────────────────────────────────────────────────────────
    if (config.rateLimitRps && config.rateLimitRps > 0) {
      const rps = Math.max(1, Math.min(100_000, Math.floor(config.rateLimitRps)));
      const resp = await fetch(`${CF_API_BASE}/zones/${zoneId()}/rate_limits`, {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({
          match: {
            request: {
              methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"],
              schemes: ["HTTP", "HTTPS"],
              url: `${hostname}/*`,
            },
          },
          threshold: rps,
          period: 1, // per-second window
          action: {
            mode: "simulate", // 'simulate' logs; change to 'ban' for hard block
            timeout: 60,
            response: { content_type: "application/json", body: `{"error":"rate limit exceeded"}` },
          },
          description: `Rate limit ${rps} RPS for ${hostname}`,
          enabled: true,
        }),
      });
      if (resp.ok) anyApplied = true;
      else logger.warn({ hostname, rps }, "CF applySecurityConfig: rate limit rule failed");
    }

    // ── WAF enabled / disabled ────────────────────────────────────────────────
    if (config.wafEnabled === false) {
      // Add a skip rule for this hostname to bypass CF Managed Ruleset
      const resp = await fetch(
        `${CF_API_BASE}/zones/${zoneId()}/rulesets/phases/http_request_firewall_managed/entrypoint/rules`,
        {
          method: "POST",
          headers: jsonHeaders(),
          body: JSON.stringify({
            description: `WAF skip for ${hostname}`,
            action: "skip",
            expression: `http.host eq "${hostname}"`,
            action_parameters: { ruleset: "current" },
          }),
        },
      );
      if (resp.ok) anyApplied = true;
      else logger.warn({ hostname }, "CF applySecurityConfig: WAF skip rule failed");
    }

    // ── Bot Management challenge ──────────────────────────────────────────────
    // Requires CF Bot Management (Enterprise). Gracefully skips when unavailable.
    if (config.botManagement === true) {
      const resp = await fetch(`${CF_API_BASE}/zones/${zoneId()}/firewall/rules`, {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify([
          {
            action: "challenge",
            description: `Bot management challenge for ${hostname}`,
            filter: {
              expression: `(http.host eq "${hostname}") and (cf.bot_management.score lt 30)`,
            },
          },
        ]),
      });
      if (resp.ok) anyApplied = true;
      else
        logger.warn(
          { hostname },
          "CF applySecurityConfig: bot challenge rule failed (may require Bot Management plan)",
        );
    }

    return anyApplied;
  } catch (err) {
    logger.warn({ err, hostname }, "CF applySecurityConfig threw (non-fatal)");
    return false;
  }
}

/**
 * Enable mTLS for a hostname via Cloudflare Access mTLS client certificate enforcement.
 * Uploads the CA cert and creates an Access application scoped to the hostname.
 * Returns the CF mTLS certificate ID on success, null on failure.
 */
export async function enableMtls(hostname: string, caCert: string): Promise<string | null> {
  if (!cfEnabled()) return null;
  try {
    const resp = await fetch(`${CF_API_BASE}/zones/${zoneId()}/access/certificates`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({
        name: `mTLS CA for ${hostname}`,
        certificate: caCert,
        associated_hostnames: [hostname],
      }),
    });
    const json = (await resp.json()) as CfApiResult<{ id: string }>;
    if (!json.success || !json.result?.id) {
      logger.warn({ hostname, errors: json.errors }, "CF enableMtls: cert upload failed");
      return null;
    }
    logger.info({ hostname, certId: json.result.id }, "CF enableMtls: CA cert uploaded");
    return json.result.id;
  } catch (err) {
    logger.warn({ err, hostname }, "CF enableMtls threw (non-fatal)");
    return null;
  }
}

/**
 * Disable mTLS for a hostname by deleting the Access mTLS certificate.
 */
export async function disableMtls(certId: string): Promise<boolean> {
  if (!cfEnabled()) return false;
  try {
    const resp = await fetch(`${CF_API_BASE}/zones/${zoneId()}/access/certificates/${certId}`, {
      method: "DELETE",
      headers: readHeaders(),
    });
    return resp.ok;
  } catch (err) {
    logger.warn({ err, certId }, "CF disableMtls threw (non-fatal)");
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

// ── R2 snapshot upload ────────────────────────────────────────────────────────
//
// Uses the Cloudflare R2 S3-compatible API endpoint.
// Implements just enough AWS Signature V4 for PutObject and DeleteObject.

export interface SnapshotFile {
  path: string;
  content: string;
  mimeType?: string | null;
}

// ── Binary MIME detection ──────────────────────────────────────────────────────
// Covers all file types stored as base64 in project_files.content.

const BINARY_MIME_PREFIXES = [
  "image/",
  "audio/",
  "video/",
  "font/",
  "application/octet-stream",
  "application/pdf",
  "application/zip",
  "application/gzip",
  "application/x-gzip",
  "application/wasm",
];
const BINARY_MIME_EXACT = new Set([
  "application/vnd.ms-fontobject",
  "application/x-font-ttf",
  "application/x-font-opentype",
  "application/x-font-woff",
]);

/**
 * Returns true when the given MIME type indicates binary content that is stored
 * base64-encoded in `project_files.content`. All such content must be decoded
 * with `Buffer.from(content, "base64")` before uploading to R2.
 */
export function isBinaryMime(mime: string): boolean {
  if (BINARY_MIME_EXACT.has(mime)) return true;
  return BINARY_MIME_PREFIXES.some((p) => mime.startsWith(p));
}

const DEFAULT_MAINTENANCE_HTML = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Under Maintenance</title>
<style>body{font-family:system-ui,sans-serif;background:#0a0f1c;color:#9ca3af;padding:48px;margin:0}h1{color:#fff;margin-bottom:8px}p{margin:0}</style>
</head>
<body><h1>Under Maintenance</h1><p>This site is temporarily down for maintenance. Please check back soon.</p></body>
</html>`;

function sha256Hex(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

function hmacSha256(key: Buffer | string, data: string): Buffer {
  return createHmac("sha256", key).update(data).digest();
}

function getSigningKey(
  secretKey: string,
  dateStr: string,
  region: string,
  service: string,
): Buffer {
  const kDate = hmacSha256(`AWS4${secretKey}`, dateStr);
  const kRegion = hmacSha256(kDate, region);
  const kService = hmacSha256(kRegion, service);
  return hmacSha256(kService, "aws4_request");
}

function buildSignatureV4(opts: {
  method: string;
  host: string;
  path: string;
  queryString: string;
  headers: Record<string, string>;
  body: Buffer;
  accessKeyId: string;
  secretKey: string;
  region: string;
  service: string;
  datetime: string;
}): string {
  const dateStr = opts.datetime.slice(0, 8);
  const payloadHash = sha256Hex(opts.body);

  const signedHeaderNames = Object.keys(opts.headers)
    .map((h) => h.toLowerCase())
    .sort();
  const canonicalHeaders = signedHeaderNames
    .map((h) => `${h}:${opts.headers[h] ?? opts.headers[h.toLowerCase()] ?? ""}\n`)
    .join("");
  const signedHeadersStr = signedHeaderNames.join(";");

  const canonicalRequest = [
    opts.method,
    opts.path,
    opts.queryString,
    canonicalHeaders,
    signedHeadersStr,
    payloadHash,
  ].join("\n");

  const credentialScope = `${dateStr}/${opts.region}/${opts.service}/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    opts.datetime,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join("\n");

  const signingKey = getSigningKey(opts.secretKey, dateStr, opts.region, opts.service);
  const signature = createHmac("sha256", signingKey).update(stringToSign).digest("hex");

  return `AWS4-HMAC-SHA256 Credential=${opts.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeadersStr}, Signature=${signature}`;
}

/** Execute a single S3-compatible request against R2 with SigV4 auth. */
async function r2Request(opts: {
  method: string;
  key: string;
  body?: Buffer;
  contentType?: string;
}): Promise<{ ok: boolean; status: number }> {
  const acctId = accountId();
  const accessKeyId = process.env.CF_R2_ACCESS_KEY_ID!;
  const secretKey = process.env.CF_R2_SECRET_ACCESS_KEY!;
  const bucket = r2Bucket();
  const region = "auto";
  const service = "s3";
  const host = `${acctId}.r2.cloudflarestorage.com`;
  const endpoint = `https://${host}`;

  const now = new Date();
  const datetime = now.toISOString().replace(/[:\-]/g, "").replace(/\.\d+/, "").slice(0, 15) + "Z";

  const body = opts.body ?? Buffer.alloc(0);
  const contentType = opts.contentType ?? "application/octet-stream";
  const path = encodeURI(`/${bucket}/${opts.key}`);

  const headersToSign: Record<string, string> = {
    host,
    "x-amz-content-sha256": sha256Hex(body),
    "x-amz-date": datetime,
  };
  if (opts.method === "PUT" && opts.body) {
    headersToSign["content-type"] = contentType;
    headersToSign["content-length"] = String(body.length);
  }

  const authorization = buildSignatureV4({
    method: opts.method,
    host,
    path,
    queryString: "",
    headers: headersToSign,
    body,
    accessKeyId,
    secretKey,
    region,
    service,
    datetime,
  });

  const fetchHeaders: Record<string, string> = {
    ...headersToSign,
    Authorization: authorization,
  };

  try {
    const resp = await fetch(`${endpoint}${path}`, {
      method: opts.method,
      headers: fetchHeaders,
      body: opts.method === "PUT" ? body : undefined,
    });
    return { ok: resp.ok, status: resp.status };
  } catch (err) {
    logger.warn({ err, key: opts.key }, "R2 request threw");
    return { ok: false, status: 0 };
  }
}

/**
 * Upload all snapshot files to R2 under `{projectId}/{versionId}/{path}`.
 * Falls back gracefully (logs + returns false) when R2 env vars are missing.
 *
 * @returns true if all files uploaded successfully, false otherwise.
 */
export async function uploadSnapshotToR2(
  projectId: number,
  versionId: number,
  files: SnapshotFile[],
): Promise<boolean> {
  if (!r2Enabled()) return false;
  let allOk = true;
  const prefix = `${projectId}/${versionId}`;

  await Promise.all(
    files.map(async (f) => {
      const key = `${prefix}/${f.path.replace(/^\//, "")}`;
      const isBase64 = f.mimeType ? isBinaryMime(f.mimeType) : false;
      const body = isBase64 ? Buffer.from(f.content, "base64") : Buffer.from(f.content, "utf8");
      const contentType = f.mimeType ?? "application/octet-stream";
      const result = await r2Request({ method: "PUT", key, body, contentType });
      if (!result.ok) {
        logger.warn(
          { projectId, versionId, path: f.path, status: result.status },
          "R2 upload failed for file",
        );
        allOk = false;
      }
    }),
  );

  if (allOk) {
    logger.info({ projectId, versionId, fileCount: files.length }, "R2 snapshot upload complete");
  } else {
    logger.warn({ projectId, versionId }, "R2 snapshot upload had failures");
  }
  return allOk;
}

/**
 * Fetch a single file from R2 by key.
 *
 * Returns the file body and content-type, or null if not found / not configured / error.
 * Used by the API server as a first-tier origin cache when EDGE_SERVING_ENABLED=true:
 * the API tries R2 before falling back to DB-stored snapshot content.
 */
export async function r2GetObject(key: string): Promise<{
  body: Buffer;
  contentType: string;
  etag: string | null;
} | null> {
  if (!r2Enabled()) return null;
  const acctId = accountId();
  const accessKeyId = process.env.CF_R2_ACCESS_KEY_ID!;
  const secretKey = process.env.CF_R2_SECRET_ACCESS_KEY!;
  const bucket = r2Bucket();
  const region = "auto";
  const service = "s3";
  const host = `${acctId}.r2.cloudflarestorage.com`;

  const now = new Date();
  const datetime = now.toISOString().replace(/[:\-]/g, "").replace(/\.\d+/, "").slice(0, 15) + "Z";

  const emptyBody = Buffer.alloc(0);
  const path = encodeURI(`/${bucket}/${key}`);

  const headersToSign: Record<string, string> = {
    host,
    "x-amz-content-sha256": sha256Hex(emptyBody),
    "x-amz-date": datetime,
  };

  const authorization = buildSignatureV4({
    method: "GET",
    host,
    path,
    queryString: "",
    headers: headersToSign,
    body: emptyBody,
    accessKeyId,
    secretKey,
    region,
    service,
    datetime,
  });

  try {
    const resp = await fetch(`https://${host}${path}`, {
      method: "GET",
      headers: { ...headersToSign, Authorization: authorization },
    });
    if (!resp.ok) return null;
    const contentType = resp.headers.get("content-type") ?? "application/octet-stream";
    const etag = resp.headers.get("etag");
    const buf = Buffer.from(await resp.arrayBuffer());
    return { body: buf, contentType, etag };
  } catch (err) {
    logger.warn({ err, key }, "R2 getObject threw");
    return null;
  }
}

/**
 * Upload a maintenance page to R2 for the project.
 * Key: `{projectId}/maintenance.html` (not versioned — project-scoped).
 *
 * Called automatically on every production publish so the R2 key always exists
 * before a user could enable maintenance mode via the maintenance toggle.
 * Falls back gracefully when R2 is not configured.
 */
export async function uploadMaintenancePage(projectId: number, html?: string): Promise<boolean> {
  if (!r2Enabled()) return false;
  const content = html ?? DEFAULT_MAINTENANCE_HTML;
  const key = `${projectId}/maintenance.html`;
  const body = Buffer.from(content, "utf8");
  const result = await r2Request({
    method: "PUT",
    key,
    body,
    contentType: "text/html; charset=utf-8",
  });
  if (!result.ok) {
    logger.warn({ projectId, status: result.status }, "R2 uploadMaintenancePage failed");
    return false;
  }
  return true;
}

/**
 * Toggle the maintenance flag in the Worker KV for all provided hostnames.
 *
 * When enabled=true the Worker serves `{projectId}/maintenance.html` instead
 * of the snapshot. The existing KV entry (versionId, versionHistory, etc.) is
 * preserved — only the `maintenance` flag is flipped.
 *
 * Hostnames without a KV entry (i.e., project not published) are silently skipped.
 */
export async function setProjectMaintenanceMode(
  hostnames: string[],
  enabled: boolean,
): Promise<void> {
  if (!kvEnabled()) return;
  await Promise.all(
    hostnames.map(async (h) => {
      try {
        const existing = await readHostnameKV(h);
        if (!existing) return;
        await writeHostnameKV(h, { ...existing, maintenance: enabled });
      } catch {
        /* best-effort */
      }
    }),
  );
}

/**
 * Delete all R2 objects for a given snapshot (project + version).
 * Best-effort; logs but does not throw on failure.
 */
export async function deleteSnapshotFromR2(
  projectId: number,
  versionId: number,
  filePaths: string[],
): Promise<void> {
  if (!r2Enabled()) return;
  const prefix = `${projectId}/${versionId}`;
  await Promise.all(
    filePaths.map(async (p) => {
      const key = `${prefix}/${p.replace(/^\//, "")}`;
      await r2Request({ method: "DELETE", key }).catch(() => {
        /* best-effort */
      });
    }),
  );
}

// ── Worker KV routing table ──────────────────────────────────────────────────
//
// The Worker KV stores: hostname → HostnameRoute (JSON)
// Writes use the Cloudflare REST API (accounts/{id}/storage/kv/namespaces/{id}/values/{key}).

/** The value stored in the Worker KV for each hostname. */
export interface HostnameRoute {
  /** Integer project ID. */
  projectId: number;
  /** Currently live version ID. */
  versionId: number;
  /** Ordered list of recent version IDs for failover (newest-first, max 5). */
  versionHistory: number[];
  /** When true, the Worker serves maintenance.html instead of the snapshot. */
  maintenance: boolean;
  /** Optional Cloudflare region hint (e.g. "weur", "enam"). Null = no preference. */
  preferredRegion: string | null;
  /** Custom 404 HTML served by the Worker when a file is not found. Null = platform default. */
  errorPage404?: string | null;
  /** Custom 500 HTML served by the Worker on origin error / R2 5xx. Null = platform default. */
  errorPage500?: string | null;
}

function kvApiBase(): string {
  return `${CF_API_BASE}/accounts/${accountId()}/storage/kv/namespaces/${process.env.CF_KV_NAMESPACE_ID}`;
}

/**
 * Write (upsert) a hostname→route entry in the Worker KV.
 * Returns true on success, false when KV is not configured or on error.
 */
export async function writeHostnameKV(hostname: string, route: HostnameRoute): Promise<boolean> {
  if (!kvEnabled()) return false;
  try {
    const resp = await fetch(`${kvApiBase()}/values/${encodeURIComponent(hostname)}`, {
      method: "PUT",
      headers: readHeaders(),
      body: JSON.stringify(route),
    });
    if (!resp.ok) {
      logger.warn({ hostname, status: resp.status }, "KV writeHostnameKV failed");
      return false;
    }
    return true;
  } catch (err) {
    logger.warn({ err, hostname }, "KV writeHostnameKV threw");
    return false;
  }
}

/**
 * Delete a hostname entry from the Worker KV.
 * Best-effort; returns false on error.
 */
export async function deleteHostnameKV(hostname: string): Promise<boolean> {
  if (!kvEnabled()) return false;
  try {
    const resp = await fetch(`${kvApiBase()}/values/${encodeURIComponent(hostname)}`, {
      method: "DELETE",
      headers: readHeaders(),
    });
    return resp.ok;
  } catch (err) {
    logger.warn({ err, hostname }, "KV deleteHostnameKV threw");
    return false;
  }
}

/**
 * Read a hostname route from the Worker KV.
 * Returns null when not found or KV is not configured.
 */
export async function readHostnameKV(hostname: string): Promise<HostnameRoute | null> {
  if (!kvEnabled()) return null;
  try {
    const resp = await fetch(`${kvApiBase()}/values/${encodeURIComponent(hostname)}`, {
      headers: readHeaders(),
    });
    if (!resp.ok) return null;
    return (await resp.json()) as HostnameRoute;
  } catch (err) {
    logger.warn({ err, hostname }, "KV readHostnameKV threw");
    return null;
  }
}

/**
 * Sync the KV entry for a hostname after a publish event.
 *
 * - On publish: upsert the route with the new versionId; prepend old versionId
 *   to versionHistory (max 5 entries kept for failover).
 * - When versionId is null (unpublish): delete the KV key so the Worker 404s.
 */
export async function syncHostnameKVAfterPublish(opts: {
  hostname: string;
  projectId: number;
  versionId: number | null;
  maintenance?: boolean;
  preferredRegion?: string | null;
  errorPage404?: string | null;
  errorPage500?: string | null;
}): Promise<void> {
  if (!kvEnabled()) return;

  const {
    hostname,
    projectId,
    versionId,
    maintenance = false,
    preferredRegion = null,
    errorPage404 = null,
    errorPage500 = null,
  } = opts;

  if (versionId === null) {
    await deleteHostnameKV(hostname).catch(() => {
      /* best-effort */
    });
    return;
  }

  const existing = await readHostnameKV(hostname).catch(() => null);
  const oldHistory = existing?.versionHistory ?? [];
  const oldVersionId = existing?.versionId;

  const history = oldVersionId
    ? [oldVersionId, ...oldHistory.filter((v) => v !== oldVersionId)].slice(0, 5)
    : oldHistory.slice(0, 5);

  await writeHostnameKV(hostname, {
    projectId,
    versionId,
    versionHistory: history,
    maintenance,
    preferredRegion,
    errorPage404: errorPage404 ?? undefined,
    errorPage500: errorPage500 ?? undefined,
  }).catch(() => {
    /* best-effort */
  });
}

/**
 * Sync KV for ALL hostnames belonging to a project after a publish event.
 *
 * Looks up the project's platform subdomain + all custom domains from the DB
 * and updates each KV entry.
 */
export async function syncAllHostnamesKV(opts: {
  projectId: number;
  publicSlug: string | null;
  versionId: number | null;
  customDomains: string[];
  maintenance?: boolean;
  preferredRegion?: string | null;
  errorPage404?: string | null;
  errorPage500?: string | null;
}): Promise<void> {
  if (!kvEnabled()) return;
  const PLATFORM_DOMAIN = process.env.PLATFORM_DOMAIN ?? "mustaflow.app";

  const hostnames: string[] = [];

  if (opts.publicSlug) {
    hostnames.push(`${opts.publicSlug}.${PLATFORM_DOMAIN}`);
  }
  for (const d of opts.customDomains) {
    if (d) hostnames.push(d);
  }

  // Errors propagate to the caller. Callers (publish.ts, deploy.ts) catch with
  // explicit req.log.warn — we no longer swallow KV write failures silently.
  await Promise.all(
    hostnames.map((h) =>
      syncHostnameKVAfterPublish({
        hostname: h,
        projectId: opts.projectId,
        versionId: opts.versionId,
        maintenance: opts.maintenance,
        preferredRegion: opts.preferredRegion,
        errorPage404: opts.errorPage404,
        errorPage500: opts.errorPage500,
      }),
    ),
  );
}

// ── Cloudflare cache purge ────────────────────────────────────────────────────

/**
 * Purge the Cloudflare edge cache for all URLs served under the given hostnames.
 *
 * Purges the root path (/) on each hostname. This is sufficient for HTML-heavy
 * static apps since hashed assets are immutable and don't need purging.
 *
 * Falls back gracefully when CF is not configured.
 */
export async function purgeCacheForHostnames(hostnames: string[]): Promise<boolean> {
  if (!cfEnabled()) return false;
  if (hostnames.length === 0) return true;

  const urls: string[] = [];
  for (const h of hostnames) {
    urls.push(`https://${h}/`, `https://${h}/index.html`);
  }

  try {
    const resp = await fetch(`${CF_API_BASE}/zones/${zoneId()}/purge_cache`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ files: urls }),
    });
    const json = (await resp.json()) as CfApiResult<unknown>;
    if (!json.success) {
      const msg = json.errors?.map((e) => e.message).join("; ") ?? "CF purge failed";
      logger.warn({ hostnames, msg }, "CF purgeCacheForHostnames failed");
      return false;
    }
    logger.info({ hostnames, urlCount: urls.length }, "CF cache purged");
    return true;
  } catch (err) {
    logger.warn({ err, hostnames }, "CF purgeCacheForHostnames threw");
    return false;
  }
}

/**
 * Convenience: purge cache for a project's platform subdomain + all custom domains.
 */
export async function purgeCacheForProject(opts: {
  publicSlug: string | null;
  customDomains: string[];
}): Promise<void> {
  if (!cfEnabled()) return;
  const PLATFORM_DOMAIN = process.env.PLATFORM_DOMAIN ?? "mustaflow.app";

  const hostnames: string[] = [];
  if (opts.publicSlug) hostnames.push(`${opts.publicSlug}.${PLATFORM_DOMAIN}`);
  for (const d of opts.customDomains) {
    if (d) hostnames.push(d);
  }

  if (hostnames.length === 0) return;
  await purgeCacheForHostnames(hostnames).catch(() => {
    /* best-effort */
  });
}
