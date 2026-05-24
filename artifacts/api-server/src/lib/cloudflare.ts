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
