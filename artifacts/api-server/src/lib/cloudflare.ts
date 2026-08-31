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
import type { CloudflareSecurityResourceReceipt } from "@workspace/db";
import { logger } from "./logger";
import { resolveProjectFileBytes } from "./project-file-asset-reference";

const CF_API_BASE = "https://api.cloudflare.com/client/v4";
const RETIREMENT_CONTROL_TIMEOUT_MS = 30_000;
const CACHE_PURGE_TAGS_PER_REQUEST = 30;
const SECURITY_RECONCILIATION_PAGE_SIZE = 100;
const SECURITY_RECONCILIATION_MAX_PAGES = 20;
const KV_INVENTORY_PAGE_SIZE = 1_000;
const KV_INVENTORY_MAX_PAGES = 20;
const KV_INVENTORY_MAX_PROJECT_ROUTES = 512;
const CUSTOM_HOSTNAME_INVENTORY_PAGE_SIZE = 100;
const CUSTOM_HOSTNAME_INVENTORY_MAX_PAGES = 20;
const CUSTOM_HOSTNAME_INVENTORY_MAX_TARGETS = 100;
const R2_RETIREMENT_LIST_PAGE_SIZE = 1_000;
const R2_RETIREMENT_DELETE_BATCH_SIZE = 1_000;
const R2_RETIREMENT_MAX_OBJECTS = 10_000;

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

export type CustomHostnameRetirementVerification =
  | { state: "absent" }
  | { state: "present" }
  | { state: "unavailable"; stage: "delete" | "read" };

/**
 * Strict certificate-release primitive for governed project retirement.
 * The ordinary domain route remains best-effort; retirement requires both an
 * accepted delete and an authoritative absent read before clearing its pointer.
 */
export async function retireCustomHostname(
  cfHostnameId: string,
): Promise<CustomHostnameRetirementVerification> {
  if (!cfEnabled()) return { state: "unavailable", stage: "delete" };
  try {
    const deleted = await fetch(
      `${CF_API_BASE}/zones/${zoneId()}/custom_hostnames/${cfHostnameId}`,
      {
        method: "DELETE",
        headers: readHeaders(),
        signal: AbortSignal.timeout(RETIREMENT_CONTROL_TIMEOUT_MS),
      },
    );
    if (!deleted.ok && deleted.status !== 404) {
      return { state: "unavailable", stage: "delete" };
    }
  } catch (err) {
    logger.warn({ err, cfHostnameId }, "CF custom hostname retirement delete threw");
    return { state: "unavailable", stage: "delete" };
  }

  try {
    const observed = await fetch(
      `${CF_API_BASE}/zones/${zoneId()}/custom_hostnames/${cfHostnameId}`,
      { headers: readHeaders(), signal: AbortSignal.timeout(RETIREMENT_CONTROL_TIMEOUT_MS) },
    );
    if (observed.status === 404) return { state: "absent" };
    if (observed.ok) return { state: "present" };
    return { state: "unavailable", stage: "read" };
  } catch (err) {
    logger.warn({ err, cfHostnameId }, "CF custom hostname retirement verification threw");
    return { state: "unavailable", stage: "read" };
  }
}

// ── WAF + Bot Management defaults — Task #560 ─────────────────────────────────

export type CloudflareSecurityApplyResult =
  | { state: "applied"; resources: CloudflareSecurityResourceReceipt[] }
  | { state: "unavailable"; resources: CloudflareSecurityResourceReceipt[] };

type CfRulesetRule = { id?: string; ref?: string; description?: string };
type CfRuleset = { id?: string; rules?: CfRulesetRule[] };
type CfFirewallRule = {
  id?: string;
  ref?: string;
  description?: string;
  filter?: { id?: string };
};
type CfRateLimit = { id?: string; description?: string };
type CfMtlsCertificate = { id?: string; name?: string };
type SecurityReconciliation<T> =
  | { state: "found"; value: T }
  | { state: "absent" }
  | { state: "unavailable" };

function stableSecurityRef(scopeIdentity: string, purpose: string): string {
  const digest = createHash("sha256")
    .update(`nabuflow:${scopeIdentity}:${purpose}`)
    .digest("hex")
    .slice(0, 32);
  return `nabuflow-${digest}`;
}

function dedupeSecurityResources(
  resources: CloudflareSecurityResourceReceipt[],
): CloudflareSecurityResourceReceipt[] {
  const unique = new Map<string, CloudflareSecurityResourceReceipt>();
  for (const resource of resources) {
    unique.set(`${resource.kind}:${resource.rulesetId ?? ""}:${resource.id}`, resource);
  }
  return [...unique.values()];
}

async function listSecurityResources<T>(path: string): Promise<SecurityReconciliation<T[]>> {
  const values: T[] = [];
  for (let page = 1; page <= SECURITY_RECONCILIATION_MAX_PAGES; page++) {
    try {
      const separator = path.includes("?") ? "&" : "?";
      const response = await fetch(
        `${CF_API_BASE}${path}${separator}page=${page}&per_page=${SECURITY_RECONCILIATION_PAGE_SIZE}`,
        { headers: readHeaders(), signal: AbortSignal.timeout(RETIREMENT_CONTROL_TIMEOUT_MS) },
      );
      if (!response.ok) return { state: "unavailable" };
      const json = (await response.json()) as CfListResult<T>;
      if (!json.success || !json.result) return { state: "unavailable" };
      values.push(...json.result);
      const total = json.result_info?.total_count;
      if (
        json.result.length < SECURITY_RECONCILIATION_PAGE_SIZE ||
        (typeof total === "number" && values.length >= total)
      ) {
        return { state: "found", value: values };
      }
    } catch {
      return { state: "unavailable" };
    }
  }
  // Refuse to append after an incomplete bounded scan.
  return { state: "unavailable" };
}

async function reconcileRulesetRule(
  phase: string,
  ref: string,
  legacyDescription?: string,
): Promise<SecurityReconciliation<CloudflareSecurityResourceReceipt>> {
  try {
    const response = await fetch(
      `${CF_API_BASE}/zones/${zoneId()}/rulesets/phases/${phase}/entrypoint`,
      { headers: readHeaders(), signal: AbortSignal.timeout(RETIREMENT_CONTROL_TIMEOUT_MS) },
    );
    if (response.status === 404) return { state: "absent" };
    if (!response.ok) return { state: "unavailable" };
    const json = (await response.json()) as CfApiResult<CfRuleset>;
    const rulesetId = json.result?.id;
    const rule = json.result?.rules?.find(
      (candidate) =>
        candidate.ref === ref ||
        (!candidate.ref && legacyDescription && candidate.description === legacyDescription),
    );
    return rulesetId && rule?.id
      ? {
          state: "found",
          value: { kind: "ruleset_rule", id: rule.id, rulesetId, ref },
        }
      : { state: "absent" };
  } catch {
    return { state: "unavailable" };
  }
}

async function ensureRulesetRule(input: {
  phase: string;
  ref: string;
  body: Record<string, unknown>;
  existing: CloudflareSecurityResourceReceipt[];
}): Promise<CloudflareSecurityResourceReceipt | null> {
  const tracked = input.existing.find(
    (resource) => resource.kind === "ruleset_rule" && resource.ref === input.ref,
  );
  if (tracked) return tracked;
  const legacyDescription =
    typeof input.body.description === "string" ? input.body.description : undefined;
  const reconciled = await reconcileRulesetRule(input.phase, input.ref, legacyDescription);
  if (reconciled.state === "found") return reconciled.value;
  if (reconciled.state === "unavailable") return null;

  try {
    const response = await fetch(
      `${CF_API_BASE}/zones/${zoneId()}/rulesets/phases/${input.phase}/entrypoint/rules`,
      {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({ ...input.body, ref: input.ref }),
        signal: AbortSignal.timeout(RETIREMENT_CONTROL_TIMEOUT_MS),
      },
    );
    if (response.ok) {
      const json = (await response.json()) as CfApiResult<CfRuleset | CfRulesetRule>;
      const result = json.result;
      if (result && "rules" in result) {
        const rule = result.rules?.find((candidate) => candidate.ref === input.ref);
        if (result.id && rule?.id) {
          return { kind: "ruleset_rule", id: rule.id, rulesetId: result.id, ref: input.ref };
        }
      }
    }
  } catch (error) {
    logger.warn({ error, ref: input.ref }, "CF ruleset create outcome was ambiguous");
  }

  // A timeout can happen after Cloudflare committed. Re-read by the stable ref
  // before allowing a caller to retry, otherwise PATCH can append duplicates.
  const afterCreate = await reconcileRulesetRule(input.phase, input.ref, legacyDescription);
  return afterCreate.state === "found" ? afterCreate.value : null;
}

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
  cfHostnameId: string,
  existingResources: CloudflareSecurityResourceReceipt[] = [],
): Promise<CloudflareSecurityApplyResult> {
  if (!cfEnabled()) return { state: "unavailable", resources: existingResources };
  const ref = stableSecurityRef(cfHostnameId, "default-waf");
  const resource = await ensureRulesetRule({
    phase: "http_request_firewall_managed",
    ref,
    existing: existingResources,
    body: {
      description: `WAF defaults for ${hostname}`,
      action: "execute",
      expression: `http.host eq "${hostname}"`,
      action_parameters: {
        id: "efb7b8c949ac4650a09736fc376e9aee",
        overrides: { enabled: true },
      },
    },
  });
  const resources = dedupeSecurityResources([
    ...existingResources,
    ...(resource ? [resource] : []),
  ]);
  if (!resource) {
    logger.warn({ hostname, ref }, "CF default WAF creation could not be reconciled");
    return { state: "unavailable", resources };
  }
  logger.info({ hostname, ref }, "CF default WAF rule reconciled");
  return { state: "applied", resources };
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
  cloudflareResources?: CloudflareSecurityResourceReceipt[];
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

async function reconcileFirewallRule(
  ref: string,
  legacyDescription?: string,
): Promise<SecurityReconciliation<CloudflareSecurityResourceReceipt[]>> {
  const listed = await listSecurityResources<CfFirewallRule>(`/zones/${zoneId()}/firewall/rules`);
  if (listed.state !== "found") return { state: "unavailable" };
  const rule = listed.value.find(
    (candidate) =>
      candidate.ref === ref ||
      (!candidate.ref && legacyDescription && candidate.description === legacyDescription),
  );
  if (!rule?.id) return { state: "absent" };
  return {
    state: "found",
    value: [
      { kind: "firewall_rule", id: rule.id, ref },
      ...(rule.filter?.id ? [{ kind: "firewall_filter" as const, id: rule.filter.id, ref }] : []),
    ],
  };
}

async function ensureFirewallRule(input: {
  ref: string;
  rule: Record<string, unknown>;
  existing: CloudflareSecurityResourceReceipt[];
}): Promise<CloudflareSecurityResourceReceipt[] | null> {
  const trackedRule = input.existing.find(
    (resource) => resource.kind === "firewall_rule" && resource.ref === input.ref,
  );
  if (trackedRule) {
    return input.existing.filter((resource) => resource.ref === input.ref);
  }
  const legacyDescription =
    typeof input.rule.description === "string" ? input.rule.description : undefined;
  const reconciled = await reconcileFirewallRule(input.ref, legacyDescription);
  if (reconciled.state === "found") return reconciled.value;
  if (reconciled.state === "unavailable") return null;
  try {
    const response = await fetch(`${CF_API_BASE}/zones/${zoneId()}/firewall/rules`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify([{ ...input.rule, ref: input.ref }]),
      signal: AbortSignal.timeout(RETIREMENT_CONTROL_TIMEOUT_MS),
    });
    if (response.ok) {
      const json = (await response.json()) as CfListResult<CfFirewallRule>;
      const rule = json.result?.find((candidate) => candidate.ref === input.ref);
      if (rule?.id) {
        return [
          { kind: "firewall_rule", id: rule.id, ref: input.ref },
          ...(rule.filter?.id
            ? [{ kind: "firewall_filter" as const, id: rule.filter.id, ref: input.ref }]
            : []),
        ];
      }
    }
  } catch (error) {
    logger.warn({ error, ref: input.ref }, "CF firewall create outcome was ambiguous");
  }
  const afterCreate = await reconcileFirewallRule(input.ref, legacyDescription);
  return afterCreate.state === "found" ? afterCreate.value : null;
}

async function reconcileRateLimit(
  ref: string,
  legacyDescription?: string,
): Promise<SecurityReconciliation<CloudflareSecurityResourceReceipt>> {
  const listed = await listSecurityResources<CfRateLimit>(`/zones/${zoneId()}/rate_limits`);
  if (listed.state !== "found") return { state: "unavailable" };
  const rateLimit = listed.value.find(
    (candidate) =>
      candidate.description === `NabuFlow ${ref}` ||
      (legacyDescription && candidate.description === legacyDescription),
  );
  return rateLimit?.id
    ? { state: "found", value: { kind: "rate_limit", id: rateLimit.id, ref } }
    : { state: "absent" };
}

async function ensureRateLimit(input: {
  ref: string;
  body: Record<string, unknown>;
  existing: CloudflareSecurityResourceReceipt[];
  legacyDescription?: string;
}): Promise<CloudflareSecurityResourceReceipt | null> {
  const tracked = input.existing.find(
    (resource) => resource.kind === "rate_limit" && resource.ref === input.ref,
  );
  if (tracked) return tracked;
  const reconciled = await reconcileRateLimit(input.ref, input.legacyDescription);
  if (reconciled.state === "found") return reconciled.value;
  if (reconciled.state === "unavailable") return null;
  try {
    const response = await fetch(`${CF_API_BASE}/zones/${zoneId()}/rate_limits`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ ...input.body, description: `NabuFlow ${input.ref}` }),
      signal: AbortSignal.timeout(RETIREMENT_CONTROL_TIMEOUT_MS),
    });
    if (response.ok) {
      const json = (await response.json()) as CfApiResult<CfRateLimit>;
      if (json.result?.id) {
        return { kind: "rate_limit", id: json.result.id, ref: input.ref };
      }
    }
  } catch (error) {
    logger.warn({ error, ref: input.ref }, "CF rate-limit create outcome was ambiguous");
  }
  const afterCreate = await reconcileRateLimit(input.ref, input.legacyDescription);
  return afterCreate.state === "found" ? afterCreate.value : null;
}

async function reconcileMtlsCertificate(
  ref: string,
  legacyName?: string,
): Promise<SecurityReconciliation<CloudflareSecurityResourceReceipt>> {
  const listed = await listSecurityResources<CfMtlsCertificate>(
    `/zones/${zoneId()}/access/certificates`,
  );
  if (listed.state !== "found") return { state: "unavailable" };
  const certificate = listed.value.find(
    (candidate) =>
      candidate.name === `NabuFlow ${ref}` || (legacyName && candidate.name === legacyName),
  );
  return certificate?.id
    ? { state: "found", value: { kind: "mtls_certificate", id: certificate.id, ref } }
    : { state: "absent" };
}

async function ensureMtlsCertificate(input: {
  hostname: string;
  caCert: string;
  ref: string;
  existing: CloudflareSecurityResourceReceipt[];
}): Promise<CloudflareSecurityResourceReceipt | null> {
  const tracked = input.existing.find(
    (resource) => resource.kind === "mtls_certificate" && resource.ref === input.ref,
  );
  if (tracked) return tracked;
  const reconciled = await reconcileMtlsCertificate(input.ref, `mTLS CA for ${input.hostname}`);
  if (reconciled.state === "found") return reconciled.value;
  if (reconciled.state === "unavailable") return null;
  try {
    const response = await fetch(`${CF_API_BASE}/zones/${zoneId()}/access/certificates`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({
        name: `NabuFlow ${input.ref}`,
        certificate: input.caCert,
        associated_hostnames: [input.hostname],
      }),
      signal: AbortSignal.timeout(RETIREMENT_CONTROL_TIMEOUT_MS),
    });
    if (response.ok) {
      const json = (await response.json()) as CfApiResult<CfMtlsCertificate>;
      if (json.result?.id) {
        return { kind: "mtls_certificate", id: json.result.id, ref: input.ref };
      }
    }
  } catch (error) {
    logger.warn({ error, ref: input.ref }, "CF mTLS create outcome was ambiguous");
  }
  const afterCreate = await reconcileMtlsCertificate(input.ref, `mTLS CA for ${input.hostname}`);
  return afterCreate.state === "found" ? afterCreate.value : null;
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
 * Returns the exact provider receipts. Stable refs make ambiguous POST outcomes
 * reconcilable and prevent repeated PATCH requests from appending duplicates.
 */
export async function applySecurityConfig(
  hostname: string,
  config: DomainSecurityConfigForCf,
  scopeIdentity = hostname,
): Promise<CloudflareSecurityApplyResult> {
  const existing = dedupeSecurityResources(config.cloudflareResources ?? []);
  if (!cfEnabled()) return { state: "unavailable", resources: existing };

  // Hostname must be a safe token (no expression metacharacters)
  if (/"/.test(hostname)) {
    logger.error({ hostname }, "CF applySecurityConfig: hostname contains quotes — aborting");
    return { state: "unavailable", resources: existing };
  }

  const resources = [...existing];
  let complete = true;
  const add = (created: CloudflareSecurityResourceReceipt[] | null): void => {
    if (!created) complete = false;
    else resources.push(...created);
  };

  const firewallRule = async (
    purpose: string,
    action: string,
    description: string,
    expression: string,
  ): Promise<void> => {
    add(
      await ensureFirewallRule({
        ref: stableSecurityRef(scopeIdentity, purpose),
        existing: resources,
        rule: { action, description, filter: { expression } },
      }),
    );
  };

  if (config.ipDeny?.length) {
    const values = config.ipDeny.filter(isValidIpOrCidr);
    if (values.length) {
      await firewallRule(
        "ip-deny",
        "block",
        `IP deny list for ${hostname}`,
        `(http.host eq "${hostname}") and (ip.src in {${values.join(" ")}})`,
      );
    }
  }
  if (config.ipAllow?.length) {
    const values = config.ipAllow.filter(isValidIpOrCidr);
    if (values.length) {
      await firewallRule(
        "ip-allow",
        "block",
        `IP allowlist enforcement for ${hostname}`,
        `(http.host eq "${hostname}") and not (ip.src in {${values.join(" ")}})`,
      );
    }
  }
  if (config.geoBlock?.length) {
    const values = config.geoBlock.filter(isValidCountryCode);
    if (values.length) {
      await firewallRule(
        "geo-block",
        "block",
        `Geo-block for ${hostname}`,
        `(http.host eq "${hostname}") and (ip.geoip.country in {${values
          .map((country) => `"${country}"`)
          .join(" ")}})`,
      );
    }
  }
  if (config.rateLimitRps && config.rateLimitRps > 0) {
    const rps = Math.max(1, Math.min(100_000, Math.floor(config.rateLimitRps)));
    const created = await ensureRateLimit({
      ref: stableSecurityRef(scopeIdentity, "rate-limit"),
      existing: resources,
      legacyDescription: `Rate limit ${rps} RPS for ${hostname}`,
      body: {
        match: {
          request: {
            methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"],
            schemes: ["HTTP", "HTTPS"],
            url: `${hostname}/*`,
          },
        },
        threshold: rps,
        period: 1,
        action: {
          mode: "simulate",
          timeout: 60,
          response: { content_type: "application/json", body: `{"error":"rate limit exceeded"}` },
        },
        enabled: true,
      },
    });
    add(created ? [created] : null);
  }
  if (config.wafEnabled === false) {
    const created = await ensureRulesetRule({
      phase: "http_request_firewall_managed",
      ref: stableSecurityRef(scopeIdentity, "waf-skip"),
      existing: resources,
      body: {
        description: `WAF skip for ${hostname}`,
        action: "skip",
        expression: `http.host eq "${hostname}"`,
        action_parameters: { ruleset: "current" },
      },
    });
    add(created ? [created] : null);
  }
  if (config.botManagement === true) {
    await firewallRule(
      "bot-management",
      "challenge",
      `Bot management challenge for ${hostname}`,
      `(http.host eq "${hostname}") and (cf.bot_management.score lt 30)`,
    );
  }
  if (config.mtlsEnabled && config.mtlsCaCert) {
    const created = await ensureMtlsCertificate({
      hostname,
      caCert: config.mtlsCaCert,
      ref: stableSecurityRef(scopeIdentity, "mtls"),
      existing: resources,
    });
    add(created ? [created] : null);
  }

  return {
    state: complete ? "applied" : "unavailable",
    resources: dedupeSecurityResources(resources),
  };
}

export type CloudflareSecurityDiscoveryResult =
  | { state: "complete"; resources: CloudflareSecurityResourceReceipt[] }
  | { state: "unavailable"; resources: CloudflareSecurityResourceReceipt[] };

type ExactSecurityIdentity = { ref: string; legacyIdentity: string };

function exactSecurityIdentities(
  scopes: string[],
  purpose: string,
  legacyIdentity: string,
): ExactSecurityIdentity[] {
  return [...new Set(scopes)].map((scope) => ({
    ref: stableSecurityRef(scope, purpose),
    legacyIdentity,
  }));
}

function matchExactSecurityIdentity<T extends { ref?: string }>(
  candidate: T,
  candidateLegacyIdentity: string | undefined,
  expected: ExactSecurityIdentity[],
): ExactSecurityIdentity | undefined {
  return expected.find(
    (identity) =>
      candidate.ref === identity.ref ||
      (!candidate.ref && candidateLegacyIdentity === identity.legacyIdentity),
  );
}

/**
 * Discover only resources with a stable ref or an exact historical description
 * derivable from this hostname/config. This never creates, updates, or deletes.
 */
export async function discoverCloudflareSecurityResources(input: {
  hostname: string;
  cfHostnameId: string | null;
  config: DomainSecurityConfigForCf;
  existing?: CloudflareSecurityResourceReceipt[];
}): Promise<CloudflareSecurityDiscoveryResult> {
  const resources = [...(input.existing ?? input.config.cloudflareResources ?? [])];
  const expectsProviderResources =
    !!input.cfHostnameId ||
    !!input.config.ipDeny?.some(isValidIpOrCidr) ||
    !!input.config.ipAllow?.some(isValidIpOrCidr) ||
    !!input.config.geoBlock?.some(isValidCountryCode) ||
    (input.config.rateLimitRps ?? 0) > 0 ||
    input.config.wafEnabled === false ||
    input.config.botManagement === true ||
    (!!input.config.mtlsEnabled && !!input.config.mtlsCaCert);
  if (!expectsProviderResources && resources.length === 0) {
    return { state: "complete", resources: [] };
  }
  if (!cfEnabled() || /"/.test(input.hostname)) {
    return { state: "unavailable", resources: dedupeSecurityResources(resources) };
  }
  const scopes = [input.cfHostnameId, input.hostname].filter((scope): scope is string => !!scope);

  const rulesetTargets: ExactSecurityIdentity[] = [];
  if (input.cfHostnameId) {
    rulesetTargets.push(
      ...exactSecurityIdentities(
        [input.cfHostnameId],
        "default-waf",
        `WAF defaults for ${input.hostname}`,
      ),
    );
  }
  if (input.config.wafEnabled === false) {
    rulesetTargets.push(
      ...exactSecurityIdentities(scopes, "waf-skip", `WAF skip for ${input.hostname}`),
    );
  }
  if (rulesetTargets.length > 0) {
    try {
      const response = await fetch(
        `${CF_API_BASE}/zones/${zoneId()}/rulesets/phases/http_request_firewall_managed/entrypoint`,
        { headers: readHeaders(), signal: AbortSignal.timeout(RETIREMENT_CONTROL_TIMEOUT_MS) },
      );
      if (response.status !== 404) {
        if (!response.ok) {
          return { state: "unavailable", resources: dedupeSecurityResources(resources) };
        }
        const json = (await response.json()) as CfApiResult<CfRuleset>;
        if (!json.success || !json.result?.id || !Array.isArray(json.result.rules)) {
          return { state: "unavailable", resources: dedupeSecurityResources(resources) };
        }
        for (const rule of json.result.rules) {
          if (!rule.id) continue;
          const identity = matchExactSecurityIdentity(rule, rule.description, rulesetTargets);
          if (identity) {
            resources.push({
              kind: "ruleset_rule",
              id: rule.id,
              rulesetId: json.result.id,
              ref: identity.ref,
            });
          }
        }
      }
    } catch {
      return { state: "unavailable", resources: dedupeSecurityResources(resources) };
    }
  }

  const firewallTargets = [
    ...(input.config.ipDeny?.some(isValidIpOrCidr)
      ? exactSecurityIdentities(scopes, "ip-deny", `IP deny list for ${input.hostname}`)
      : []),
    ...(input.config.ipAllow?.some(isValidIpOrCidr)
      ? exactSecurityIdentities(
          scopes,
          "ip-allow",
          `IP allowlist enforcement for ${input.hostname}`,
        )
      : []),
    ...(input.config.geoBlock?.some(isValidCountryCode)
      ? exactSecurityIdentities(scopes, "geo-block", `Geo-block for ${input.hostname}`)
      : []),
    ...(input.config.botManagement === true
      ? exactSecurityIdentities(
          scopes,
          "bot-management",
          `Bot management challenge for ${input.hostname}`,
        )
      : []),
  ];
  if (firewallTargets.length > 0) {
    const listed = await listSecurityResources<CfFirewallRule>(`/zones/${zoneId()}/firewall/rules`);
    if (listed.state !== "found") {
      return { state: "unavailable", resources: dedupeSecurityResources(resources) };
    }
    for (const rule of listed.value) {
      if (!rule.id) continue;
      const identity = matchExactSecurityIdentity(rule, rule.description, firewallTargets);
      if (!identity) continue;
      resources.push({ kind: "firewall_rule", id: rule.id, ref: identity.ref });
      if (rule.filter?.id) {
        resources.push({ kind: "firewall_filter", id: rule.filter.id, ref: identity.ref });
      }
    }
  }

  if (input.config.rateLimitRps && input.config.rateLimitRps > 0) {
    const rps = Math.max(1, Math.min(100_000, Math.floor(input.config.rateLimitRps)));
    const targets = exactSecurityIdentities(
      scopes,
      "rate-limit",
      `Rate limit ${rps} RPS for ${input.hostname}`,
    );
    const listed = await listSecurityResources<CfRateLimit>(`/zones/${zoneId()}/rate_limits`);
    if (listed.state !== "found") {
      return { state: "unavailable", resources: dedupeSecurityResources(resources) };
    }
    for (const rateLimit of listed.value) {
      if (!rateLimit.id) continue;
      const identity = targets.find(
        (target) =>
          rateLimit.description === `NabuFlow ${target.ref}` ||
          rateLimit.description === target.legacyIdentity,
      );
      if (identity) {
        resources.push({ kind: "rate_limit", id: rateLimit.id, ref: identity.ref });
      }
    }
  }

  if (input.config.mtlsEnabled && input.config.mtlsCaCert) {
    const targets = exactSecurityIdentities(scopes, "mtls", `mTLS CA for ${input.hostname}`);
    const listed = await listSecurityResources<CfMtlsCertificate>(
      `/zones/${zoneId()}/access/certificates`,
    );
    if (listed.state !== "found") {
      return { state: "unavailable", resources: dedupeSecurityResources(resources) };
    }
    for (const certificate of listed.value) {
      if (!certificate.id) continue;
      const identity = targets.find(
        (target) =>
          certificate.name === `NabuFlow ${target.ref}` ||
          certificate.name === target.legacyIdentity,
      );
      if (identity) {
        resources.push({ kind: "mtls_certificate", id: certificate.id, ref: identity.ref });
      }
    }
  }

  return { state: "complete", resources: dedupeSecurityResources(resources) };
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

export type CloudflareSecurityRetirementVerification =
  | { state: "absent" }
  | { state: "present" }
  | { state: "unavailable"; stage: "delete" | "read" };

function securityResourcePath(resource: CloudflareSecurityResourceReceipt): string | null {
  switch (resource.kind) {
    case "ruleset_rule":
      return resource.rulesetId
        ? `/zones/${zoneId()}/rulesets/${resource.rulesetId}/rules/${resource.id}`
        : null;
    case "firewall_rule":
      return `/zones/${zoneId()}/firewall/rules/${resource.id}`;
    case "firewall_filter":
      return `/zones/${zoneId()}/filters/${resource.id}`;
    case "rate_limit":
      return `/zones/${zoneId()}/rate_limits/${resource.id}`;
    case "mtls_certificate":
      return `/zones/${zoneId()}/access/certificates/${resource.id}`;
  }
}

/**
 * Delete one exact tracked security resource and authoritatively verify it is
 * absent. A transport error is never converted into a successful receipt.
 */
export async function retireCloudflareSecurityResource(
  resource: CloudflareSecurityResourceReceipt,
): Promise<CloudflareSecurityRetirementVerification> {
  if (!cfEnabled()) return { state: "unavailable", stage: "delete" };
  const path = securityResourcePath(resource);
  if (!path) return { state: "unavailable", stage: "delete" };
  try {
    const deleted = await fetch(`${CF_API_BASE}${path}`, {
      method: "DELETE",
      headers: readHeaders(),
      signal: AbortSignal.timeout(RETIREMENT_CONTROL_TIMEOUT_MS),
    });
    if (!deleted.ok && deleted.status !== 404) {
      return { state: "unavailable", stage: "delete" };
    }
  } catch (error) {
    logger.warn({ error, resource }, "CF security-resource retirement delete threw");
    return { state: "unavailable", stage: "delete" };
  }

  try {
    if (resource.kind === "ruleset_rule") {
      const response = await fetch(
        `${CF_API_BASE}/zones/${zoneId()}/rulesets/${resource.rulesetId}`,
        { headers: readHeaders(), signal: AbortSignal.timeout(RETIREMENT_CONTROL_TIMEOUT_MS) },
      );
      if (response.status === 404) return { state: "absent" };
      if (!response.ok) return { state: "unavailable", stage: "read" };
      const json = (await response.json()) as CfApiResult<CfRuleset>;
      if (!json.success || !json.result) return { state: "unavailable", stage: "read" };
      return json.result?.rules?.some((rule) => rule.id === resource.id)
        ? { state: "present" }
        : { state: "absent" };
    }
    const observed = await fetch(`${CF_API_BASE}${path}`, {
      headers: readHeaders(),
      signal: AbortSignal.timeout(RETIREMENT_CONTROL_TIMEOUT_MS),
    });
    if (observed.status === 404) return { state: "absent" };
    if (observed.ok) {
      const json = (await observed.json()) as CfApiResult<unknown>;
      return json.success ? { state: "present" } : { state: "unavailable", stage: "read" };
    }
    return { state: "unavailable", stage: "read" };
  } catch (error) {
    logger.warn({ error, resource }, "CF security-resource retirement verification threw");
    return { state: "unavailable", stage: "read" };
  }
}

export type CloudflareSecurityRetirementBatch = {
  state: "absent" | "unavailable";
  outcomes: Array<{
    resource: CloudflareSecurityResourceReceipt;
    verification: CloudflareSecurityRetirementVerification;
  }>;
};

/** Bounded exact-resource cleanup used by detach surfaces. */
export async function retireCloudflareSecurityResources(
  resources: CloudflareSecurityResourceReceipt[],
): Promise<CloudflareSecurityRetirementBatch> {
  const ordered = dedupeSecurityResources(resources).sort((left, right) => {
    // Cloudflare firewall-rule deletion does not delete its filter. Remove the
    // rule first so the filter is no longer in use.
    const rank = (kind: CloudflareSecurityResourceReceipt["kind"]): number =>
      kind === "firewall_rule" ? 0 : kind === "firewall_filter" ? 2 : 1;
    return rank(left.kind) - rank(right.kind);
  });
  const outcomes: CloudflareSecurityRetirementBatch["outcomes"] = [];
  const concurrency = 4;
  for (let offset = 0; offset < ordered.length; offset += concurrency) {
    const batch = ordered.slice(offset, offset + concurrency);
    outcomes.push(
      ...(await Promise.all(
        batch.map(async (resource) => ({
          resource,
          verification: await retireCloudflareSecurityResource(resource),
        })),
      )),
    );
    if (outcomes.some((outcome) => outcome.verification.state !== "absent")) {
      return { state: "unavailable", outcomes };
    }
  }
  return { state: "absent", outcomes };
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

export type StrictCustomHostnameMatch = {
  id: string;
  hostname: string;
};

export type StrictCustomHostnameInventory =
  | { state: "complete"; matches: StrictCustomHostnameMatch[] }
  | { state: "unavailable"; stage: "input" | "config" | "read" | "parse" | "cap" };

function normalizeInventoryHostname(hostname: string): string | null {
  const normalized = hostname.trim().toLowerCase().replace(/\.$/, "");
  if (normalized.length === 0 || normalized.length > 253 || /[\s/\\]/.test(normalized)) {
    return null;
  }
  return normalized;
}

/**
 * Strict, bounded provider inventory for exact custom-hostname targets.
 *
 * Unlike listCustomHostnames(), this proof surface never converts an
 * incomplete provider read into an empty result. A non-OK response,
 * malformed page, pagination cap, or transport failure is unavailable.
 * Only the matched provider id and hostname cross the boundary.
 */
export async function inventoryCustomHostnamesByHostname(
  hostnames: readonly string[],
): Promise<StrictCustomHostnameInventory> {
  if (hostnames.length === 0) return { state: "complete", matches: [] };
  if (hostnames.length > CUSTOM_HOSTNAME_INVENTORY_MAX_TARGETS) {
    return { state: "unavailable", stage: "input" };
  }

  const normalizedTargets = hostnames.map(normalizeInventoryHostname);
  if (normalizedTargets.some((hostname) => hostname === null)) {
    return { state: "unavailable", stage: "input" };
  }
  if (!cfEnabled()) return { state: "unavailable", stage: "config" };

  const targetSet = new Set(normalizedTargets as string[]);
  const matches = new Map<string, StrictCustomHostnameMatch>();
  let expectedTotal: number | null = null;
  let observedCount = 0;

  for (let page = 1; page <= CUSTOM_HOSTNAME_INVENTORY_MAX_PAGES; page++) {
    try {
      const resp = await fetch(
        `${CF_API_BASE}/zones/${zoneId()}/custom_hostnames?page=${page}&per_page=${CUSTOM_HOSTNAME_INVENTORY_PAGE_SIZE}`,
        {
          headers: readHeaders(),
          signal: AbortSignal.timeout(RETIREMENT_CONTROL_TIMEOUT_MS),
        },
      );
      if (!resp.ok) return { state: "unavailable", stage: "read" };

      let json: unknown;
      try {
        json = await resp.json();
      } catch {
        return { state: "unavailable", stage: "parse" };
      }
      if (!json || typeof json !== "object") {
        return { state: "unavailable", stage: "parse" };
      }
      const pageResult = json as Partial<CfListResult<unknown>>;
      if (pageResult.success !== true || !Array.isArray(pageResult.result)) {
        return { state: "unavailable", stage: "parse" };
      }
      const info = pageResult.result_info;
      if (
        !info ||
        !Number.isInteger(info.count) ||
        info.count !== pageResult.result.length ||
        !Number.isInteger(info.page) ||
        info.page !== page ||
        !Number.isInteger(info.per_page) ||
        info.per_page !== CUSTOM_HOSTNAME_INVENTORY_PAGE_SIZE ||
        !Number.isInteger(info.total_count) ||
        info.total_count < 0
      ) {
        return { state: "unavailable", stage: "parse" };
      }
      if (expectedTotal === null) expectedTotal = info.total_count;
      if (expectedTotal !== info.total_count) {
        return { state: "unavailable", stage: "parse" };
      }
      if (
        expectedTotal >
        CUSTOM_HOSTNAME_INVENTORY_PAGE_SIZE * CUSTOM_HOSTNAME_INVENTORY_MAX_PAGES
      ) {
        return { state: "unavailable", stage: "cap" };
      }

      for (const candidate of pageResult.result) {
        if (!candidate || typeof candidate !== "object") {
          return { state: "unavailable", stage: "parse" };
        }
        const record = candidate as Record<string, unknown>;
        if (
          typeof record.id !== "string" ||
          record.id.length === 0 ||
          typeof record.hostname !== "string"
        ) {
          return { state: "unavailable", stage: "parse" };
        }
        const normalized = normalizeInventoryHostname(record.hostname);
        if (!normalized) return { state: "unavailable", stage: "parse" };
        if (targetSet.has(normalized)) {
          matches.set(record.id, { id: record.id, hostname: normalized });
        }
      }

      observedCount += pageResult.result.length;
      if (observedCount > expectedTotal) {
        return { state: "unavailable", stage: "parse" };
      }
      if (observedCount === expectedTotal) {
        return {
          state: "complete",
          matches: [...matches.values()].sort(
            (left, right) =>
              left.hostname.localeCompare(right.hostname) || left.id.localeCompare(right.id),
          ),
        };
      }
      if (pageResult.result.length !== CUSTOM_HOSTNAME_INVENTORY_PAGE_SIZE) {
        return { state: "unavailable", stage: "parse" };
      }
    } catch (err) {
      logger.warn({ err, page }, "CF strict custom-hostname inventory threw");
      return { state: "unavailable", stage: "read" };
    }
  }

  return { state: "unavailable", stage: "cap" };
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
  cacheControl?: string;
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
  // eslint-disable-next-line no-useless-escape
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
    if (opts.cacheControl) {
      headersToSign["cache-control"] = opts.cacheControl;
    }
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

type StrictR2ControlResult =
  | { state: "complete"; status: number; body: string }
  | { state: "unavailable"; status: number };

function encodeAwsQueryComponent(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function canonicalAwsQuery(entries: ReadonlyArray<readonly [string, string]>): string {
  const compare = (left: string, right: string): number =>
    left < right ? -1 : left > right ? 1 : 0;
  return entries
    .map(([key, value]) => [encodeAwsQueryComponent(key), encodeAwsQueryComponent(value)] as const)
    .sort(
      ([leftKey, leftValue], [rightKey, rightValue]) =>
        compare(leftKey, rightKey) || compare(leftValue, rightValue),
    )
    .map(([key, value]) => `${key}=${value}`)
    .join("&");
}

/** Strict S3 control request used only by bounded retirement proofs. */
async function strictR2ControlRequest(opts: {
  method: "GET" | "POST";
  query: ReadonlyArray<readonly [string, string]>;
  body?: Buffer;
}): Promise<StrictR2ControlResult> {
  const acctId = accountId();
  const accessKeyId = process.env.CF_R2_ACCESS_KEY_ID!;
  const secretKey = process.env.CF_R2_SECRET_ACCESS_KEY!;
  const bucket = r2Bucket();
  const region = "auto";
  const service = "s3";
  const host = `${acctId}.r2.cloudflarestorage.com`;
  const path = encodeURI(`/${bucket}`);
  const queryString = canonicalAwsQuery(opts.query);
  const body = opts.body ?? Buffer.alloc(0);
  const now = new Date();
  // eslint-disable-next-line no-useless-escape
  const datetime = now.toISOString().replace(/[:\-]/g, "").replace(/\.\d+/, "").slice(0, 15) + "Z";
  const headersToSign: Record<string, string> = {
    host,
    "x-amz-content-sha256": sha256Hex(body),
    "x-amz-date": datetime,
  };
  if (opts.method === "POST") {
    headersToSign["content-type"] = "application/xml";
    headersToSign["content-length"] = String(body.length);
    headersToSign["content-md5"] = createHash("md5").update(body).digest("base64");
  }
  const authorization = buildSignatureV4({
    method: opts.method,
    host,
    path,
    queryString,
    headers: headersToSign,
    body,
    accessKeyId,
    secretKey,
    region,
    service,
    datetime,
  });

  try {
    const response = await fetch(`https://${host}${path}?${queryString}`, {
      method: opts.method,
      headers: { ...headersToSign, Authorization: authorization },
      body: opts.method === "POST" ? body : undefined,
      signal: AbortSignal.timeout(RETIREMENT_CONTROL_TIMEOUT_MS),
    });
    if (!response.ok) return { state: "unavailable", status: response.status };
    try {
      return { state: "complete", status: response.status, body: await response.text() };
    } catch {
      return { state: "unavailable", status: response.status };
    }
  } catch (err) {
    logger.warn({ err, method: opts.method }, "R2 strict retirement request threw");
    return { state: "unavailable", status: 0 };
  }
}

function decodeXmlText(value: string): string | null {
  if (/[<>]/.test(value)) return null;
  if (/&(?!(?:amp|quot|apos|lt|gt|#\d+|#x[0-9a-f]+);)/i.test(value)) return null;
  try {
    return value
      .replace(/&#(\d+);/g, (_match, decimal: string) => String.fromCodePoint(Number(decimal)))
      .replace(/&#x([0-9a-f]+);/gi, (_match, hex: string) =>
        String.fromCodePoint(Number.parseInt(hex, 16)),
      )
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&amp;/g, "&");
  } catch {
    return null;
  }
}

function xmlElementValues(xml: string, element: string): string[] | null {
  const values: string[] = [];
  const expression = new RegExp(`<${element}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${element}>`, "g");
  for (const match of xml.matchAll(expression)) {
    const decoded = decodeXmlText(match[1] ?? "");
    if (decoded === null) return null;
    values.push(decoded);
  }
  return values;
}

function isSingleXmlDocument(xml: string, root: string, allowSelfClosing = false): boolean {
  const normalized = xml.trim().replace(/^<\?xml[^>]*>\s*/, "");
  const openingCount = normalized.match(new RegExp(`<${root}(?:\\s[^>]*)?\\/?>`, "g"))?.length ?? 0;
  const closingCount = normalized.match(new RegExp(`<\\/${root}>`, "g"))?.length ?? 0;
  if (openingCount !== 1) return false;
  if (allowSelfClosing && closingCount === 0) {
    return new RegExp(`^<${root}(?:\\s[^>]*)?\\s*\\/>$`).test(normalized);
  }
  return (
    closingCount === 1 &&
    new RegExp(`^<${root}(?:\\s[^>]*)?>[\\s\\S]*<\\/${root}>$`).test(normalized)
  );
}

type StrictR2ListPage =
  | { state: "complete"; keys: string[]; truncated: false }
  | { state: "complete"; keys: string[]; truncated: true; nextToken: string }
  | { state: "unavailable" };

async function listStrictR2PrefixPage(
  prefix: string,
  maxKeys: number,
  continuationToken?: string,
): Promise<StrictR2ListPage> {
  const query: Array<readonly [string, string]> = [
    ["list-type", "2"],
    ["max-keys", String(maxKeys)],
    ["prefix", prefix],
  ];
  if (continuationToken) query.push(["continuation-token", continuationToken]);
  const response = await strictR2ControlRequest({ method: "GET", query });
  if (response.state !== "complete") return { state: "unavailable" };
  const xml = response.body;
  if (!isSingleXmlDocument(xml, "ListBucketResult") || /<Error(?:\s[^>]*)?>/.test(xml)) {
    return { state: "unavailable" };
  }
  const keys = xmlElementValues(xml, "Key");
  const keyCount = xmlElementValues(xml, "KeyCount");
  const truncated = xmlElementValues(xml, "IsTruncated");
  if (
    !keys ||
    !keyCount ||
    keyCount.length !== 1 ||
    !/^\d+$/.test(keyCount[0] ?? "") ||
    Number(keyCount[0]) !== keys.length ||
    keys.length > maxKeys ||
    keys.some((key) => !key.startsWith(prefix)) ||
    !truncated ||
    truncated.length !== 1 ||
    !["true", "false"].includes(truncated[0] ?? "")
  ) {
    return { state: "unavailable" };
  }
  if (truncated[0] === "false") return { state: "complete", keys, truncated: false };
  const tokens = xmlElementValues(xml, "NextContinuationToken");
  if (!tokens || tokens.length !== 1 || !tokens[0]) return { state: "unavailable" };
  return { state: "complete", keys, truncated: true, nextToken: tokens[0] };
}

function escapeXmlText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

async function deleteStrictR2Keys(keys: readonly string[]): Promise<boolean> {
  const body = Buffer.from(
    `<?xml version="1.0" encoding="UTF-8"?><Delete>${keys
      .map((key) => `<Object><Key>${escapeXmlText(key)}</Key></Object>`)
      .join("")}<Quiet>true</Quiet></Delete>`,
    "utf8",
  );
  const response = await strictR2ControlRequest({ method: "POST", query: [["delete", ""]], body });
  if (response.state !== "complete") return false;
  return (
    isSingleXmlDocument(response.body, "DeleteResult", true) &&
    !/<Error(?:\s[^>]*)?>/.test(response.body)
  );
}

export type LegacyR2ProjectPrefixRetirement =
  | { state: "not_configured"; discoveredCount: 0; deletedCount: 0 }
  | { state: "absent"; discoveredCount: number; deletedCount: number }
  | {
      state: "unavailable";
      stage: "input" | "config" | "list" | "cap" | "delete" | "verify";
      discoveredCount: number;
      deletedCount: number;
    };

/**
 * Strictly retires legacy snapshot objects under the numeric `{projectId}/`
 * prefix, with bounded inventory/deletion and an authoritative absence read.
 * Object keys never cross this function's result boundary.
 */
export async function retireLegacyR2ProjectPrefix(
  projectId: number,
): Promise<LegacyR2ProjectPrefixRetirement> {
  if (!Number.isSafeInteger(projectId) || projectId <= 0) {
    return { state: "unavailable", stage: "input", discoveredCount: 0, deletedCount: 0 };
  }

  const requiredConfig = [
    process.env.CF_ACCOUNT_ID,
    process.env.CF_R2_ACCESS_KEY_ID,
    process.env.CF_R2_SECRET_ACCESS_KEY,
  ];
  const hasAnyConfig =
    requiredConfig.some((value) => Boolean(value)) || process.env.CF_R2_BUCKET !== undefined;
  if (!hasAnyConfig) return { state: "not_configured", discoveredCount: 0, deletedCount: 0 };
  if (requiredConfig.some((value) => !value) || r2Bucket().trim().length === 0) {
    return { state: "unavailable", stage: "config", discoveredCount: 0, deletedCount: 0 };
  }

  const prefix = `${projectId}/`;
  const keys: string[] = [];
  const seenKeys = new Set<string>();
  const seenTokens = new Set<string>();
  let continuationToken: string | undefined;
  while (true) {
    const page = await listStrictR2PrefixPage(
      prefix,
      R2_RETIREMENT_LIST_PAGE_SIZE,
      continuationToken,
    );
    if (page.state !== "complete") {
      return { state: "unavailable", stage: "list", discoveredCount: keys.length, deletedCount: 0 };
    }
    if (page.keys.some((key) => seenKeys.has(key))) {
      return { state: "unavailable", stage: "list", discoveredCount: keys.length, deletedCount: 0 };
    }
    if (keys.length + page.keys.length > R2_RETIREMENT_MAX_OBJECTS) {
      return { state: "unavailable", stage: "cap", discoveredCount: keys.length, deletedCount: 0 };
    }
    keys.push(...page.keys);
    for (const key of page.keys) seenKeys.add(key);
    if (!page.truncated) break;
    if (keys.length === R2_RETIREMENT_MAX_OBJECTS || seenTokens.has(page.nextToken)) {
      return { state: "unavailable", stage: "cap", discoveredCount: keys.length, deletedCount: 0 };
    }
    seenTokens.add(page.nextToken);
    continuationToken = page.nextToken;
  }

  let deletedCount = 0;
  for (let offset = 0; offset < keys.length; offset += R2_RETIREMENT_DELETE_BATCH_SIZE) {
    const batch = keys.slice(offset, offset + R2_RETIREMENT_DELETE_BATCH_SIZE);
    if (!(await deleteStrictR2Keys(batch))) {
      return {
        state: "unavailable",
        stage: "delete",
        discoveredCount: keys.length,
        deletedCount,
      };
    }
    deletedCount += batch.length;
  }

  const verification = await listStrictR2PrefixPage(prefix, 1);
  if (
    verification.state !== "complete" ||
    verification.truncated ||
    verification.keys.length !== 0
  ) {
    return {
      state: "unavailable",
      stage: "verify",
      discoveredCount: keys.length,
      deletedCount,
    };
  }
  return { state: "absent", discoveredCount: keys.length, deletedCount };
}

/**
 * Delays between upload attempts in milliseconds (exponential backoff).
 * 3 entries → 4 total attempts (1 initial + 3 retries): 500 ms, 1 s, 2 s.
 */
const R2_RETRY_DELAYS_MS = [500, 1000, 2000];

/** Maximum upload attempts per file (1 initial + 3 retries = 4 total). */
const R2_MAX_ATTEMPTS = R2_RETRY_DELAYS_MS.length + 1;

/**
 * Upload a single object to R2 by key, retried with the same exponential
 * backoff as snapshot uploads (500 ms → 1 s → 2 s; 4 attempts total).
 *
 * Returns true on success, false when R2 is not configured or all attempts
 * fail — callers are expected to fall back to their own durable store.
 */
export async function r2PutObject(
  key: string,
  body: Buffer,
  contentType?: string,
  cacheControl?: string,
): Promise<boolean> {
  if (!r2Enabled()) return false;
  let lastStatus = 0;
  for (let attempt = 0; attempt < R2_MAX_ATTEMPTS; attempt++) {
    if (attempt > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, R2_RETRY_DELAYS_MS[attempt - 1]));
    }
    const result = await r2Request({ method: "PUT", key, body, contentType, cacheControl });
    if (result.ok) return true;
    lastStatus = result.status;
    logger.warn(
      { key, status: result.status, attempt: attempt + 1 },
      "R2 putObject attempt failed",
    );
  }
  logger.warn({ key, status: lastStatus, attempts: R2_MAX_ATTEMPTS }, "R2 putObject failed");
  return false;
}

/**
 * Delete a single object from R2 by key. Best-effort: returns true on a 2xx
 * (R2 treats DELETE of a missing key as success), false when not configured or
 * on error. Callers should not treat a false return as fatal.
 */
export async function r2DeleteObject(key: string): Promise<boolean> {
  if (!r2Enabled()) return false;
  const result = await r2Request({ method: "DELETE", key });
  if (!result.ok) {
    logger.warn({ key, status: result.status }, "R2 deleteObject failed");
  }
  return result.ok;
}

/**
 * Derive the correct Cache-Control value for an R2 file path.
 * HTML entry points use `no-cache` so browsers always revalidate.
 * All other assets (JS, CSS, images, etc.) use long-lived immutable caching.
 */
export function r2CacheControl(filePath: string): string {
  return filePath.endsWith(".html") ? "no-cache" : "public, max-age=31536000, immutable";
}

/**
 * Upload all snapshot files to R2 under `{projectId}/{versionId}/{path}`.
 * Falls back gracefully (logs + returns false) when R2 env vars are missing.
 *
 * Each file upload is retried up to 3 attempts with exponential backoff
 * (500 ms → 1 s → 2 s) before being marked as failed.
 *
 * Every PUT includes a `Cache-Control` header:
 *   - HTML files → `no-cache`
 *   - All other files → `public, max-age=31536000, immutable`
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
      const body = isBase64
        ? await resolveProjectFileBytes({
            projectId,
            content: f.content,
            mimeType: f.mimeType ?? "application/octet-stream",
            legacyEncoding: "base64",
          })
        : Buffer.from(f.content, "utf8");
      const contentType = f.mimeType ?? "application/octet-stream";
      const cacheControl = r2CacheControl(f.path);

      let lastStatus = 0;
      for (let attempt = 0; attempt < R2_MAX_ATTEMPTS; attempt++) {
        if (attempt > 0) {
          await new Promise<void>((resolve) =>
            setTimeout(resolve, R2_RETRY_DELAYS_MS[attempt - 1]),
          );
        }
        const result = await r2Request({ method: "PUT", key, body, contentType, cacheControl });
        if (result.ok) return;
        lastStatus = result.status;
        logger.warn(
          { projectId, versionId, path: f.path, status: result.status, attempt: attempt + 1 },
          "R2 upload attempt failed",
        );
      }

      logger.warn(
        { projectId, versionId, path: f.path, status: lastStatus, attempts: R2_MAX_ATTEMPTS },
        "R2 upload failed for file after all retries",
      );
      allOk = false;
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
  // eslint-disable-next-line no-useless-escape
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
): Promise<{ updated: string[]; failed: string[]; configured: boolean }> {
  if (!kvEnabled()) return { updated: [], failed: [], configured: false };
  const outcomes = await Promise.all(
    hostnames.map(async (h) => {
      try {
        const existing = await readHostnameKV(h);
        if (!existing) return { hostname: h, state: "failed" as const };
        await writeHostnameKV(h, { ...existing, maintenance: enabled });
        return { hostname: h, state: "updated" as const };
      } catch {
        return { hostname: h, state: "failed" as const };
      }
    }),
  );
  return {
    configured: true,
    updated: outcomes.filter((item) => item.state === "updated").map((item) => item.hostname),
    failed: outcomes.filter((item) => item.state === "failed").map((item) => item.hostname),
  };
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

export type HostnameRouteObservation = {
  hostname: string;
  route: HostnameRoute;
};

export type HostnameRouteReadResult =
  | { state: "found"; observation: HostnameRouteObservation }
  | { state: "absent" }
  | { state: "unavailable" };

export type HostnameRouteInventoryResult =
  | { state: "complete"; observations: HostnameRouteObservation[] }
  | { state: "unavailable"; observations: HostnameRouteObservation[] };

interface CfKvKeyListResult {
  success: boolean;
  result?: Array<{ name?: string }>;
  result_info?: { cursor?: string };
}

function isHostnameRoute(value: unknown): value is HostnameRoute {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const route = value as Partial<HostnameRoute>;
  return (
    Number.isSafeInteger(route.projectId) &&
    Number(route.projectId) > 0 &&
    Number.isSafeInteger(route.versionId) &&
    Number(route.versionId) > 0 &&
    Array.isArray(route.versionHistory) &&
    route.versionHistory.length <= 5 &&
    route.versionHistory.every((version) => Number.isSafeInteger(version) && version > 0) &&
    typeof route.maintenance === "boolean" &&
    (route.preferredRegion === null || typeof route.preferredRegion === "string") &&
    (route.errorPage404 === undefined ||
      route.errorPage404 === null ||
      typeof route.errorPage404 === "string") &&
    (route.errorPage500 === undefined ||
      route.errorPage500 === null ||
      typeof route.errorPage500 === "string")
  );
}

function sameHostnameRoute(left: HostnameRoute, right: HostnameRoute): boolean {
  return (
    left.projectId === right.projectId &&
    left.versionId === right.versionId &&
    left.maintenance === right.maintenance &&
    left.preferredRegion === right.preferredRegion &&
    left.errorPage404 === right.errorPage404 &&
    left.errorPage500 === right.errorPage500 &&
    left.versionHistory.length === right.versionHistory.length &&
    left.versionHistory.every((version, index) => version === right.versionHistory[index])
  );
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

export type HostnameRetirementVerification =
  | { state: "absent" }
  | { state: "present" }
  | { state: "unavailable"; stage: "delete" | "read" };

/** Authoritative metadata read. Unlike readHostnameKV, errors are not folded into absence. */
export async function readHostnameKVObservation(
  hostname: string,
): Promise<HostnameRouteReadResult> {
  if (!kvEnabled()) return { state: "unavailable" };
  try {
    const response = await fetch(`${kvApiBase()}/values/${encodeURIComponent(hostname)}`, {
      headers: readHeaders(),
      signal: AbortSignal.timeout(RETIREMENT_CONTROL_TIMEOUT_MS),
    });
    if (response.status === 404) return { state: "absent" };
    if (!response.ok) return { state: "unavailable" };
    const value: unknown = await response.json();
    return isHostnameRoute(value)
      ? { state: "found", observation: { hostname, route: value } }
      : { state: "unavailable" };
  } catch (error) {
    logger.warn({ error, hostname }, "KV route metadata read threw");
    return { state: "unavailable" };
  }
}

/**
 * Delete only the route identity that was authoritatively observed. KV has no
 * server-side CAS, so the immediate pre-delete re-read is fail-closed if the
 * hostname was republished or reassigned before cleanup reached it.
 */
export async function retireObservedHostnameKV(
  observation: HostnameRouteObservation,
): Promise<HostnameRetirementVerification> {
  const current = await readHostnameKVObservation(observation.hostname);
  if (current.state === "absent") return { state: "absent" };
  if (current.state === "unavailable") return { state: "unavailable", stage: "read" };
  if (!sameHostnameRoute(current.observation.route, observation.route)) {
    return { state: "present" };
  }
  try {
    const deleted = await fetch(
      `${kvApiBase()}/values/${encodeURIComponent(observation.hostname)}`,
      {
        method: "DELETE",
        headers: readHeaders(),
        signal: AbortSignal.timeout(RETIREMENT_CONTROL_TIMEOUT_MS),
      },
    );
    if (!deleted.ok && deleted.status !== 404) {
      return { state: "unavailable", stage: "delete" };
    }
  } catch (error) {
    logger.warn({ error, hostname: observation.hostname }, "KV route retirement delete threw");
    return { state: "unavailable", stage: "delete" };
  }
  const afterDelete = await readHostnameKVObservation(observation.hostname);
  if (afterDelete.state === "absent") return { state: "absent" };
  if (afterDelete.state === "found") return { state: "present" };
  return { state: "unavailable", stage: "read" };
}

/**
 * Strict route-retirement primitive. Unlike the ordinary publish synchronizer,
 * this never treats a transport failure as absence: both the DELETE and a
 * subsequent authoritative 404 read are required before cleanup may advance.
 */
export async function retireHostnameKV(
  hostname: string,
  expectedProjectId?: number,
): Promise<HostnameRetirementVerification> {
  const observed = await readHostnameKVObservation(hostname);
  if (observed.state === "absent") return { state: "absent" };
  if (observed.state === "unavailable") return { state: "unavailable", stage: "read" };
  if (
    expectedProjectId !== undefined &&
    observed.observation.route.projectId !== expectedProjectId
  ) {
    return { state: "present" };
  }
  return retireObservedHostnameKV(observed.observation);
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
 * Bounded full-namespace reconciliation for every hostname still pointing at a
 * project. This recovers overwritten slug history that no database row retains.
 * An incomplete provider scan or malformed routing value is never called clean.
 */
export async function inventoryHostnameKVRoutesByProject(
  projectId: number,
): Promise<HostnameRouteInventoryResult> {
  const observations: HostnameRouteObservation[] = [];
  if (!kvEnabled() || !Number.isSafeInteger(projectId) || projectId < 1) {
    return { state: "unavailable", observations };
  }
  const seen = new Set<string>();
  let cursor: string | null = null;
  for (let page = 0; page < KV_INVENTORY_MAX_PAGES; page += 1) {
    let listed: CfKvKeyListResult;
    try {
      const query = new URLSearchParams({
        limit: String(KV_INVENTORY_PAGE_SIZE),
        ...(cursor === null ? {} : { cursor }),
      });
      const response = await fetch(`${kvApiBase()}/keys?${query.toString()}`, {
        headers: readHeaders(),
        signal: AbortSignal.timeout(RETIREMENT_CONTROL_TIMEOUT_MS),
      });
      if (!response.ok) return { state: "unavailable", observations };
      listed = (await response.json()) as CfKvKeyListResult;
    } catch (error) {
      logger.warn({ error, projectId }, "KV route inventory list threw");
      return { state: "unavailable", observations };
    }
    if (!listed.success || !Array.isArray(listed.result)) {
      return { state: "unavailable", observations };
    }
    const names = listed.result
      .map((entry) => entry.name)
      .filter((name): name is string => {
        return typeof name === "string" && name.length > 0 && name.length <= 253;
      });
    if (names.length !== listed.result.length) {
      return { state: "unavailable", observations };
    }
    for (let offset = 0; offset < names.length; offset += 4) {
      const reads = await Promise.all(
        names.slice(offset, offset + 4).map((hostname) => readHostnameKVObservation(hostname)),
      );
      for (const read of reads) {
        if (read.state === "unavailable") return { state: "unavailable", observations };
        if (read.state !== "found" || read.observation.route.projectId !== projectId) continue;
        if (!seen.has(read.observation.hostname)) {
          seen.add(read.observation.hostname);
          observations.push(read.observation);
        }
        if (observations.length > KV_INVENTORY_MAX_PROJECT_ROUTES) {
          return { state: "unavailable", observations };
        }
      }
    }
    const nextCursor = listed.result_info?.cursor;
    if (typeof nextCursor !== "string" || nextCursor.length === 0) {
      return { state: "complete", observations };
    }
    if (nextCursor === cursor) return { state: "unavailable", observations };
    cursor = nextCursor;
  }
  return { state: "unavailable", observations };
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

export function cloudflareHostnameCacheTag(hostname: string): string | null {
  const normalized = hostname.trim().toLowerCase().replace(/\.$/, "");
  if (
    normalized.length < 1 ||
    normalized.length > 253 ||
    !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(
      normalized,
    )
  ) {
    return null;
  }
  return `nabuflow-host-${normalized}`;
}

/** Exact eviction for every cached path and regional Cache API key of a hostname. */
export async function purgeCacheForHostnames(hostnames: string[]): Promise<boolean> {
  if (hostnames.length === 0) return true;
  if (!cfEnabled()) return false;

  const tags = [...new Set(hostnames.map(cloudflareHostnameCacheTag))];
  if (tags.some((tag) => tag === null)) return false;
  const exactTags = tags as string[];

  try {
    for (let offset = 0; offset < exactTags.length; offset += CACHE_PURGE_TAGS_PER_REQUEST) {
      const batch = exactTags.slice(offset, offset + CACHE_PURGE_TAGS_PER_REQUEST);
      const resp = await fetch(`${CF_API_BASE}/zones/${zoneId()}/purge_cache`, {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({ tags: batch }),
        signal: AbortSignal.timeout(RETIREMENT_CONTROL_TIMEOUT_MS),
      });
      const json = (await resp.json()) as CfApiResult<unknown>;
      if (!resp.ok || !json.success) {
        const msg = json.errors?.map((e) => e.message).join("; ") ?? "CF purge failed";
        logger.warn({ hostnames, msg }, "CF purgeCacheForHostnames failed");
        return false;
      }
    }
    logger.info({ hostnames, tagCount: exactTags.length }, "CF hostname cache tags purged");
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
