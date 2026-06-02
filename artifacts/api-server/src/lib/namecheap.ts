/**
 * Namecheap Reseller API client wrapper.
 *
 * All methods gracefully no-op (return null / empty) when the required
 * environment variables are missing, mirroring the container.ts / cloudflare.ts
 * degradation pattern.
 *
 * Required env vars:
 *   NAMECHEAP_API_USER    — Namecheap username that owns the API key
 *   NAMECHEAP_API_KEY     — API key from Namecheap Profile > API Access
 *   NAMECHEAP_USERNAME    — Usually same as API_USER (the reseller account)
 *   NAMECHEAP_CLIENT_IP   — The whitelisted IP from which API calls originate
 *
 * Optional env vars:
 *   NAMECHEAP_SANDBOX     — Set to "true" to use the sandbox API endpoint
 *
 * One-time setup:
 *   1. Create a Namecheap reseller account at https://www.namecheap.com/reseller/
 *   2. Enable API access in Profile > Tools > API Access
 *   3. Whitelist your server's outbound IP in the API access settings
 *   4. For sandbox testing, enable sandbox in Profile > Tools > API Access
 *      and use the sandbox endpoint (https://api.sandbox.namecheap.com/xml.response)
 *
 * The Namecheap API speaks XML. We use a minimal regex-based extractor
 * for the specific fields we need (avoids adding an XML parser dependency).
 */

import { logger } from "./logger";

const SANDBOX_API = "https://api.sandbox.namecheap.com/xml.response";
const PROD_API = "https://api.namecheap.com/xml.response";

export function namecheapEnabled(): boolean {
  return Boolean(
    process.env.NAMECHEAP_API_USER &&
    process.env.NAMECHEAP_API_KEY &&
    process.env.NAMECHEAP_USERNAME &&
    process.env.NAMECHEAP_CLIENT_IP,
  );
}

function apiBase(): string {
  return process.env.NAMECHEAP_SANDBOX === "true" ? SANDBOX_API : PROD_API;
}

function baseParams(): URLSearchParams {
  const params = new URLSearchParams();
  params.set("ApiUser", process.env.NAMECHEAP_API_USER!);
  params.set("ApiKey", process.env.NAMECHEAP_API_KEY!);
  params.set("UserName", process.env.NAMECHEAP_USERNAME!);
  params.set("ClientIp", process.env.NAMECHEAP_CLIENT_IP!);
  return params;
}

async function callApi(command: string, extra: Record<string, string>): Promise<string | null> {
  if (!namecheapEnabled()) return null;
  try {
    const params = baseParams();
    params.set("Command", command);
    for (const [k, v] of Object.entries(extra)) {
      params.set(k, v);
    }
    const resp = await fetch(`${apiBase()}?${params.toString()}`, {
      method: "GET",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    });
    if (!resp.ok) {
      logger.warn({ command, status: resp.status }, "Namecheap API HTTP error");
      return null;
    }
    return await resp.text();
  } catch (err) {
    logger.warn({ err, command }, "Namecheap API call threw");
    return null;
  }
}

/** Extract a single XML attribute value by attribute name from a raw XML string. */
function attr(xml: string, attrName: string): string | null {
  const re = new RegExp(`${attrName}="([^"]*)"`, "i");
  const m = re.exec(xml);
  return m?.[1] ?? null;
}

/** Extract text content of a specific XML element. */
function text(xml: string, tagName: string): string | null {
  const re = new RegExp(`<${tagName}[^>]*>([^<]*)</${tagName}>`, "i");
  const m = re.exec(xml);
  return m?.[1]?.trim() ?? null;
}

/** Check whether the API response is a success (Status="OK"). */
function isSuccess(xml: string): boolean {
  return /<ApiResponse[^>]*Status="OK"/i.test(xml);
}

/** Extract all error messages from the response. */
function extractErrors(xml: string): string {
  const errors: string[] = [];
  const re = /<Error[^>]*>([^<]*)<\/Error>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    if (m[1]?.trim()) errors.push(m[1].trim());
  }
  return errors.join("; ") || "Unknown Namecheap error";
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface DomainAvailability {
  domain: string;
  available: boolean;
  isPremium: boolean;
  premiumRegistrationPrice?: number;
  regularPrice?: number;
}

export interface TldPricing {
  tld: string;
  registerPrice: number;
  renewalPrice: number;
  transferPrice: number;
}

export interface DomainRegistrationResult {
  domain: string;
  orderId: string;
  transactionId: string;
  success: boolean;
  error?: string;
}

export interface DomainInfo {
  domain: string;
  status: string;
  expiresAt: string | null;
  autoRenew: boolean;
  whoisGuard: boolean;
  nameservers: string[];
}

export interface DomainRenewalResult {
  domain: string;
  orderId: string;
  success: boolean;
  error?: string;
}

export interface TransferResult {
  domain: string;
  orderId: string;
  transferId: string;
  success: boolean;
  error?: string;
}

// ── Our Cloudflare nameservers to wire up at registration ─────────────────────
// These are set automatically when a domain is purchased through MustaFlow.
const MUSTAFLOW_NAMESERVERS = [
  process.env.NS1_HOSTNAME ?? "ns1.mustaflow.app",
  process.env.NS2_HOSTNAME ?? "ns2.mustaflow.app",
].filter(Boolean);

// ── Pricing markup (applied on top of Namecheap's cost price) ─────────────────
// Operator-configurable via DOMAIN_MARKUP_PERCENT (default 20%).
function applyMarkup(cost: number): number {
  const pct = parseFloat(process.env.DOMAIN_MARKUP_PERCENT ?? "20");
  return Math.ceil(cost * (1 + pct / 100) * 100) / 100;
}

// ── Domain name search / availability ─────────────────────────────────────────

/**
 * Check availability for one or more fully-qualified domain names.
 * Returns an array of availability results (one per domain).
 */
export async function checkAvailability(domains: string[]): Promise<DomainAvailability[]> {
  if (!namecheapEnabled()) return [];
  const xml = await callApi("namecheap.domains.check", {
    DomainList: domains.join(","),
  });
  if (!xml) return [];

  const results: DomainAvailability[] = [];
  const re =
    /<DomainCheckResult[^>]*Domain="([^"]*)"[^>]*Available="([^"]*)"[^>]*(?:IsPremiumName="([^"]*)")?[^>]*(?:PremiumRegistrationPrice="([^"]*)")?[^>]*\/?>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const domain = m[1] ?? "";
    const available = m[2]?.toLowerCase() === "true";
    const isPremium = m[3]?.toLowerCase() === "true";
    const premiumPrice = m[4] ? parseFloat(m[4]) : undefined;
    results.push({ domain, available, isPremium, premiumRegistrationPrice: premiumPrice });
  }
  return results;
}

/**
 * Get registration + renewal pricing for the standard TLDs we support.
 * Results are returned with our markup applied.
 * Cached in memory for 5 minutes to reduce API calls.
 */
let pricingCache: { data: TldPricing[]; expiresAt: number } | null = null;

export async function getPricing(tlds?: string[]): Promise<TldPricing[]> {
  if (!namecheapEnabled()) return [];

  if (pricingCache && pricingCache.expiresAt > Date.now()) {
    const cached = pricingCache.data;
    return tlds ? cached.filter((p) => tlds.includes(p.tld)) : cached;
  }

  const xml = await callApi("namecheap.users.getPricing", {
    ProductType: "DOMAIN",
    ActionName: "REGISTER",
  });
  if (!xml || !isSuccess(xml)) return [];

  const results: TldPricing[] = [];
  // Extract pricing from ProductType/ProductCategory/Product elements
  const prodRe =
    /<Product\s+Name="([^"]*)"[^>]*>[\s\S]*?<Price\s+Duration="1"[^>]*CostPrice="([^"]*)"[^>]*RenewalCostPrice="([^"]*)"[^>]*\/?>/gi;
  let m: RegExpExecArray | null;
  while ((m = prodRe.exec(xml)) !== null) {
    const tld = m[1]?.toLowerCase();
    if (!tld) continue;
    const registerCost = parseFloat(m[2] ?? "0");
    const renewalCost = parseFloat(m[3] ?? "0");
    if (isNaN(registerCost) || registerCost <= 0) continue;
    results.push({
      tld: tld.startsWith(".") ? tld : `.${tld}`,
      registerPrice: applyMarkup(registerCost),
      renewalPrice: applyMarkup(renewalCost > 0 ? renewalCost : registerCost),
      transferPrice: applyMarkup(registerCost),
    });
  }

  // Fallback: if the structured parse yields nothing, try a simpler format
  if (results.length === 0) {
    const simpleRe = /<Product\s+Name="([^"]*)"[^>]*CostPrice="([^"]*)"[^>]*\/>/gi;
    while ((m = simpleRe.exec(xml)) !== null) {
      const tld = m[1]?.toLowerCase();
      const cost = parseFloat(m[2] ?? "0");
      if (!tld || isNaN(cost) || cost <= 0) continue;
      results.push({
        tld: tld.startsWith(".") ? tld : `.${tld}`,
        registerPrice: applyMarkup(cost),
        renewalPrice: applyMarkup(cost),
        transferPrice: applyMarkup(cost),
      });
    }
  }

  pricingCache = { data: results, expiresAt: Date.now() + 5 * 60_000 };
  return tlds ? results.filter((p) => tlds.includes(p.tld)) : results;
}

// ── Domain registration ────────────────────────────────────────────────────────

export interface WhoisContact {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  address: string;
  city: string;
  stateProvince: string;
  postalCode: string;
  country: string;
}

/**
 * Register a domain name with Namecheap.
 * WHOIS privacy is enabled by default.
 * Nameservers are set to the MustaFlow Cloudflare nameservers.
 */
export async function register(
  domain: string,
  contact: WhoisContact,
  years = 1,
): Promise<DomainRegistrationResult | null> {
  if (!namecheapEnabled()) return null;

  const [sld, ...tldParts] = domain.split(".");
  const tld = tldParts.join(".");

  const params: Record<string, string> = {
    DomainName: domain,
    Years: String(years),
    AuxBillingFirstName: contact.firstName,
    AuxBillingLastName: contact.lastName,
    AuxBillingAddress1: contact.address,
    AuxBillingCity: contact.city,
    AuxBillingStateProvince: contact.stateProvince,
    AuxBillingPostalCode: contact.postalCode,
    AuxBillingCountry: contact.country,
    AuxBillingPhone: contact.phone,
    AuxBillingEmailAddress: contact.email,
    TechFirstName: contact.firstName,
    TechLastName: contact.lastName,
    TechAddress1: contact.address,
    TechCity: contact.city,
    TechStateProvince: contact.stateProvince,
    TechPostalCode: contact.postalCode,
    TechCountry: contact.country,
    TechPhone: contact.phone,
    TechEmailAddress: contact.email,
    AdminFirstName: contact.firstName,
    AdminLastName: contact.lastName,
    AdminAddress1: contact.address,
    AdminCity: contact.city,
    AdminStateProvince: contact.stateProvince,
    AdminPostalCode: contact.postalCode,
    AdminCountry: contact.country,
    AdminPhone: contact.phone,
    AdminEmailAddress: contact.email,
    RegistrantFirstName: contact.firstName,
    RegistrantLastName: contact.lastName,
    RegistrantAddress1: contact.address,
    RegistrantCity: contact.city,
    RegistrantStateProvince: contact.stateProvince,
    RegistrantPostalCode: contact.postalCode,
    RegistrantCountry: contact.country,
    RegistrantPhone: contact.phone,
    RegistrantEmailAddress: contact.email,
    AddFreeWhoisguard: "yes",
    WGEnabled: "yes",
  };

  // Wire nameservers to our Cloudflare zone
  if (MUSTAFLOW_NAMESERVERS.length >= 2) {
    params["Nameservers"] = MUSTAFLOW_NAMESERVERS.join(",");
  }

  // Suppress unused var warning
  void sld;
  void tld;

  const xml = await callApi("namecheap.domains.create", params);
  if (!xml) return null;

  if (!isSuccess(xml)) {
    return {
      domain,
      orderId: "",
      transactionId: "",
      success: false,
      error: extractErrors(xml),
    };
  }

  const orderId = attr(xml, "OrderID") ?? attr(xml, "OrderId") ?? "";
  const transactionId = attr(xml, "TransactionID") ?? attr(xml, "TransactionId") ?? "";

  return { domain, orderId, transactionId, success: true };
}

// ── Domain renewal ─────────────────────────────────────────────────────────────

export async function renew(domain: string, years = 1): Promise<DomainRenewalResult | null> {
  if (!namecheapEnabled()) return null;

  const xml = await callApi("namecheap.domains.renew", {
    DomainName: domain,
    Years: String(years),
  });
  if (!xml) return null;

  if (!isSuccess(xml)) {
    return { domain, orderId: "", success: false, error: extractErrors(xml) };
  }

  const orderId = attr(xml, "OrderID") ?? attr(xml, "OrderId") ?? "";
  return { domain, orderId, success: true };
}

// ── Domain info ────────────────────────────────────────────────────────────────

export async function getInfo(domain: string): Promise<DomainInfo | null> {
  if (!namecheapEnabled()) return null;

  const xml = await callApi("namecheap.domains.getInfo", {
    DomainName: domain,
  });
  if (!xml || !isSuccess(xml)) return null;

  const status = attr(xml, "Status") ?? "Unknown";
  const expiresAtStr = text(xml, "ExpiredDate") ?? attr(xml, "ExpireDate") ?? null;
  const autoRenewStr = attr(xml, "AutoRenew") ?? "false";
  const whoisGuardStr = attr(xml, "WhoisGuard") ?? "NOTPRESENT";

  const nsMatches: string[] = [];
  const nsRe = /<Nameserver>([^<]+)<\/Nameserver>/gi;
  let m: RegExpExecArray | null;
  while ((m = nsRe.exec(xml)) !== null) {
    if (m[1]) nsMatches.push(m[1].trim());
  }

  return {
    domain,
    status,
    expiresAt: expiresAtStr,
    autoRenew: autoRenewStr.toLowerCase() === "true",
    whoisGuard: whoisGuardStr.toUpperCase() !== "NOTPRESENT",
    nameservers: nsMatches,
  };
}

// ── Nameserver management ──────────────────────────────────────────────────────

export async function setNameservers(domain: string, ns: string[]): Promise<boolean> {
  if (!namecheapEnabled()) return false;

  const [sld, ...tldParts] = domain.split(".");
  const tld = tldParts.join(".");

  const xml = await callApi("namecheap.domains.dns.setCustom", {
    SLD: sld ?? "",
    TLD: tld,
    Nameservers: ns.join(","),
  });
  if (!xml) return false;
  return isSuccess(xml);
}

export async function setToMustaflowNameservers(domain: string): Promise<boolean> {
  if (MUSTAFLOW_NAMESERVERS.length < 2) {
    logger.warn({ domain }, "Namecheap: NS1/NS2 env vars not set — skipping nameserver update");
    return false;
  }
  return setNameservers(domain, MUSTAFLOW_NAMESERVERS);
}

// ── Auto-renew toggle ──────────────────────────────────────────────────────────

export async function setAutoRenew(domain: string, enable: boolean): Promise<boolean> {
  if (!namecheapEnabled()) return false;

  const xml = await callApi("namecheap.domains.setContacts", {
    DomainName: domain,
    // Namecheap doesn't have a direct setAutoRenew command; it's done via
    // namecheap.domains.autorenew.enable / disable (unofficial but documented).
  });
  // Use the dedicated autorenew commands
  void xml;
  const renewXml = await callApi(
    enable ? "namecheap.domains.autorenew.enable" : "namecheap.domains.autorenew.disable",
    { DomainName: domain },
  );
  if (!renewXml) return false;
  return isSuccess(renewXml);
}

// ── WHOIS contacts update ──────────────────────────────────────────────────────

export async function setWhoisContacts(domain: string, contact: WhoisContact): Promise<boolean> {
  if (!namecheapEnabled()) return false;

  const contactFields: Record<string, string> = {
    DomainName: domain,
    RegistrantFirstName: contact.firstName,
    RegistrantLastName: contact.lastName,
    RegistrantAddress1: contact.address,
    RegistrantCity: contact.city,
    RegistrantStateProvince: contact.stateProvince,
    RegistrantPostalCode: contact.postalCode,
    RegistrantCountry: contact.country,
    RegistrantPhone: contact.phone,
    RegistrantEmailAddress: contact.email,
    TechFirstName: contact.firstName,
    TechLastName: contact.lastName,
    TechAddress1: contact.address,
    TechCity: contact.city,
    TechStateProvince: contact.stateProvince,
    TechPostalCode: contact.postalCode,
    TechCountry: contact.country,
    TechPhone: contact.phone,
    TechEmailAddress: contact.email,
    AdminFirstName: contact.firstName,
    AdminLastName: contact.lastName,
    AdminAddress1: contact.address,
    AdminCity: contact.city,
    AdminStateProvince: contact.stateProvince,
    AdminPostalCode: contact.postalCode,
    AdminCountry: contact.country,
    AdminPhone: contact.phone,
    AdminEmailAddress: contact.email,
    AuxBillingFirstName: contact.firstName,
    AuxBillingLastName: contact.lastName,
    AuxBillingAddress1: contact.address,
    AuxBillingCity: contact.city,
    AuxBillingStateProvince: contact.stateProvince,
    AuxBillingPostalCode: contact.postalCode,
    AuxBillingCountry: contact.country,
    AuxBillingPhone: contact.phone,
    AuxBillingEmailAddress: contact.email,
  };

  const xml = await callApi("namecheap.domains.setContacts", contactFields);
  if (!xml) return false;
  return isSuccess(xml);
}

// ── Auth code (EPP code for transfer-out) ─────────────────────────────────────

export async function getAuthCode(domain: string): Promise<string | null> {
  if (!namecheapEnabled()) return null;

  const xml = await callApi("namecheap.domains.getInfo", { DomainName: domain });
  if (!xml || !isSuccess(xml)) return null;

  return text(xml, "DomainAuthCode") ?? attr(xml, "DomainAuthCode") ?? null;
}

// ── Registrar lock toggle ──────────────────────────────────────────────────────

export async function setRegistrarLock(domain: string, locked: boolean): Promise<boolean> {
  if (!namecheapEnabled()) return false;

  const xml = await callApi(
    locked ? "namecheap.domains.setRegistrarLock" : "namecheap.domains.setRegistrarUnlock",
    { DomainName: domain },
  );
  if (!xml) return false;
  return isSuccess(xml);
}

// ── Transfer in ───────────────────────────────────────────────────────────────

export async function transferIn(
  domain: string,
  authCode: string,
  contact: WhoisContact,
  years = 1,
): Promise<TransferResult | null> {
  if (!namecheapEnabled()) return null;

  const xml = await callApi("namecheap.domains.transfer.create", {
    DomainName: domain,
    EPPCode: authCode,
    Years: String(years),
    RegistrantFirstName: contact.firstName,
    RegistrantLastName: contact.lastName,
    RegistrantAddress1: contact.address,
    RegistrantCity: contact.city,
    RegistrantStateProvince: contact.stateProvince,
    RegistrantPostalCode: contact.postalCode,
    RegistrantCountry: contact.country,
    RegistrantPhone: contact.phone,
    RegistrantEmailAddress: contact.email,
    TechFirstName: contact.firstName,
    TechLastName: contact.lastName,
    TechAddress1: contact.address,
    TechCity: contact.city,
    TechStateProvince: contact.stateProvince,
    TechPostalCode: contact.postalCode,
    TechCountry: contact.country,
    TechPhone: contact.phone,
    TechEmailAddress: contact.email,
    AdminFirstName: contact.firstName,
    AdminLastName: contact.lastName,
    AdminAddress1: contact.address,
    AdminCity: contact.city,
    AdminStateProvince: contact.stateProvince,
    AdminPostalCode: contact.postalCode,
    AdminCountry: contact.country,
    AdminPhone: contact.phone,
    AdminEmailAddress: contact.email,
    AuxBillingFirstName: contact.firstName,
    AuxBillingLastName: contact.lastName,
    AuxBillingAddress1: contact.address,
    AuxBillingCity: contact.city,
    AuxBillingStateProvince: contact.stateProvince,
    AuxBillingPostalCode: contact.postalCode,
    AuxBillingCountry: contact.country,
    AuxBillingPhone: contact.phone,
    AuxBillingEmailAddress: contact.email,
    AddFreeWhoisguard: "yes",
    WGEnabled: "yes",
  });

  if (!xml) return null;

  if (!isSuccess(xml)) {
    return { domain, orderId: "", transferId: "", success: false, error: extractErrors(xml) };
  }

  const orderId = attr(xml, "OrderID") ?? attr(xml, "OrderId") ?? "";
  const transferId = attr(xml, "TransferID") ?? attr(xml, "TransferId") ?? "";
  return { domain, orderId, transferId, success: true };
}

/**
 * Get transfer status for a pending inbound transfer.
 * Returns null when Namecheap is not configured.
 */
export async function getTransferStatus(transferId: string): Promise<{
  status: string;
  domain: string;
} | null> {
  if (!namecheapEnabled()) return null;

  const xml = await callApi("namecheap.domains.transfer.getStatus", {
    TransferID: transferId,
  });
  if (!xml || !isSuccess(xml)) return null;

  const status = attr(xml, "Status") ?? "Unknown";
  const domain = attr(xml, "DomainName") ?? "";
  return { status, domain };
}
