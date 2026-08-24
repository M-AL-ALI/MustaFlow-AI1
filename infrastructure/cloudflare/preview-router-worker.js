/* global Headers, Response, URL, fetch */
// Replit's application router serves page paths from static assets and forwards
// only /api/* to Express. Route every preview request through this API bridge so
// the authenticated preview gateway, not the static shell, owns the response.
const PREVIEW_HOST_PATTERN = /^p\d+\.preview\.mustaflow\.com$/i;
const ORIGIN = "https://musta-flow-ai.replit.app";
const PREVIEW_BRIDGE_PREFIX = "/api/b5-preview";

const NOT_FOUND =
  '<!doctype html><html><head><meta charset="utf-8"><title>Preview not found</title></head>' +
  '<body style="font-family:system-ui,sans-serif;padding:2rem"><h1>Preview not found</h1></body></html>';

export function isPreviewRelayHost(host) {
  return PREVIEW_HOST_PATTERN.test(host);
}

export async function relayPreviewRequest(request, env) {
  const incomingUrl = new URL(request.url);
  if (!isPreviewRelayHost(incomingUrl.hostname)) {
    return new Response(NOT_FOUND, {
      status: 404,
      headers: { "content-type": "text/html; charset=UTF-8", "cache-control": "no-store" },
    });
  }
  if (!env.B5_RELAY_SECRET) {
    return new Response("Preview relay is not configured.", { status: 503 });
  }

  const publicRequestPath = incomingUrl.pathname + incomingUrl.search;
  const target = new URL(PREVIEW_BRIDGE_PREFIX + publicRequestPath, ORIGIN);
  const headers = new Headers(request.headers);
  headers.set("X-B5-Preview-Host", incomingUrl.host);
  headers.set("X-B5-Preview-Path", publicRequestPath);
  headers.set("X-B5-Relay-Auth", env.B5_RELAY_SECRET);
  headers.set("Host", target.host);

  const upstream = await fetch(target, {
    method: request.method,
    headers,
    body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
    redirect: "manual",
  });
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: upstream.headers,
  });
}

export default {
  fetch: relayPreviewRequest,
};
