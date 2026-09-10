import type { ClientRequest } from "node:http";

function platformCookie(name: string): boolean {
  return /^(?:__session(?:_|$)|__clerk(?:_|$)|__client(?:_|$)|__prs$)/u.test(name);
}

/** Platform authentication terminates at the preview gateway, never in tenant code. */
export function stripPreviewUpstreamCredentials(request: ClientRequest): void {
  for (const name of request.getHeaderNames()) {
    const lower = name.toLowerCase();
    if (
      lower === "authorization" ||
      lower === "proxy-authorization" ||
      lower.startsWith("x-clerk-") ||
      lower.startsWith("x-b5-")
    ) {
      request.removeHeader(name);
    }
  }
  const raw = request.getHeader("cookie");
  const text = Array.isArray(raw) ? raw.join("; ") : typeof raw === "string" ? raw : "";
  const cookies = text.split(";").flatMap((part) => {
    const pair = part.trim();
    const separator = pair.indexOf("=");
    if (separator <= 0) return [];
    const name = pair.slice(0, separator).trim();
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u.test(name) || platformCookie(name)) return [];
    return [pair];
  });
  if (cookies.length) request.setHeader("cookie", cookies.join("; "));
  else request.removeHeader("cookie");
}

/** A tenant response must not replace a platform session or preview access grant. */
export function filterPreviewResponseCookies(cookies: string[] | undefined): string[] | undefined {
  const safe = cookies?.filter((cookie) => {
    const separator = cookie.indexOf("=");
    return separator > 0 && !platformCookie(cookie.slice(0, separator).trim());
  });
  return safe?.length ? safe : undefined;
}
