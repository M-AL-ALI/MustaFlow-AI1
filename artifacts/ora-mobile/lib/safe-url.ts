/**
 * Native port of the website's URL safety filter
 * (artifacts/mustaflow/src/components/ora/ora-source-cards.tsx). Web-found media
 * and citations returned by Ora are untrusted: a poisoned image/source/video URL
 * pointing at localhost or a private/internal host would turn a chat reply into
 * an SSRF-style probe of the device's own network the moment <Image> auto-fetches
 * it or the user taps it open. Every web-origin URL must pass isSafeHttpUrl
 * before it is rendered, opened, or saved.
 *
 * React Native's built-in URL is unreliable for hostname parsing and no url
 * polyfill is installed, so the host is extracted with a small regex. The web
 * guard relies on `new URL().hostname` which canonicalizes numeric IPv4 hosts
 * (decimal `2130706433`, short `127.1`, octal `0177.0.0.1`, hex `0x7f000001`)
 * to dotted-quad before the private-range check. We replicate that
 * canonicalization here so those obfuscated forms cannot bypass the filter.
 */

/** Extract the bare hostname (no scheme, userinfo, port, or path) from a URL. */
function extractHostname(url: string): string | null {
  const afterScheme = url.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, "");
  const authority = afterScheme.split(/[/?#]/)[0] ?? "";
  const hostPort = authority.includes("@")
    ? authority.slice(authority.lastIndexOf("@") + 1)
    : authority;
  if (!hostPort) return null;
  if (hostPort.startsWith("[")) {
    const end = hostPort.indexOf("]");
    if (end === -1) return null;
    return hostPort.slice(0, end + 1); // keep brackets to match URL().hostname
  }
  const host = hostPort.split(":")[0];
  return host || null;
}

/**
 * Sentinel returned by canonicalizeIPv4 for a host that looks like a numeric
 * IPv4 address but is malformed/overflowing. The WHATWG URL parser treats these
 * as a fatal parse failure (so `new URL()` throws and the web guard rejects
 * them); we mirror that by classifying them as unsafe.
 */
const IPV4_INVALID = "\u0000ipv4-invalid";

/**
 * Canonicalize a numeric IPv4 host (in any of the dotted/decimal/octal/hex forms
 * the URL spec accepts) to a dotted-quad string. Returns:
 *   - a dotted-quad string for a valid numeric IPv4,
 *   - IPV4_INVALID for a numeric-looking but malformed/overflowing host, or
 *   - null when the host is not numeric IPv4 (i.e. an ordinary domain).
 */
function canonicalizeIPv4(host: string): string | null {
  const parts = host.split(".");
  if (parts.length === 0 || parts.length > 4) return null;
  const nums: number[] = [];
  for (const part of parts) {
    if (part === "") return null;
    let value: number;
    if (/^0x[0-9a-f]+$/i.test(part)) {
      value = parseInt(part.slice(2), 16);
    } else if (/^0[0-7]+$/.test(part)) {
      value = parseInt(part, 8);
    } else if (/^[0-9]+$/.test(part)) {
      value = parseInt(part, 10);
    } else {
      return null; // contains non-numeric characters -> treat as a domain
    }
    if (!Number.isFinite(value)) return IPV4_INVALID;
    nums.push(value);
  }
  const n = nums.length;
  for (let i = 0; i < n - 1; i++) {
    if (nums[i] > 255) return IPV4_INVALID;
  }
  if (nums[n - 1] >= Math.pow(256, 5 - n)) return IPV4_INVALID;
  let addr = nums[n - 1];
  for (let i = 0; i < n - 1; i++) {
    addr += nums[i] * Math.pow(256, 3 - i);
  }
  const a = (addr >>> 24) & 255;
  const b = (addr >>> 16) & 255;
  const c = (addr >>> 8) & 255;
  const d = addr & 255;
  return `${a}.${b}.${c}.${d}`;
}

/**
 * Reject hostnames that point at the local machine or a private/internal
 * network. Mirrors the web implementation rule-for-rule, plus numeric-IPv4
 * canonicalization (which the browser's URL parser does for free).
 */
function isPrivateOrLocalHost(hostname: string): boolean {
  let host = hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.+$/, "");
  const mapped = host.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (mapped) host = mapped[1];
  if (
    host === "localhost" ||
    host === "0.0.0.0" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal")
  ) {
    return true;
  }
  if (host === "::1" || /^f[cd][0-9a-f]{2}:/.test(host) || /^fe[89ab][0-9a-f]:/.test(host)) {
    return true;
  }
  const canonical = canonicalizeIPv4(host);
  if (canonical === IPV4_INVALID) return true;
  if (canonical) host = canonical;
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 127 || a === 10 || a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
  }
  return false;
}

/** Only public http(s) links may be rendered, auto-fetched, opened, or saved. */
export function isSafeHttpUrl(url: string): boolean {
  const trimmed = url.trim();
  if (!/^https?:\/\//i.test(trimmed)) return false;
  const host = extractHostname(trimmed);
  if (!host) return false;
  return !isPrivateOrLocalHost(host);
}
