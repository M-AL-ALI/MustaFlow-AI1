"use strict";

// Builder-only cross-origin isolation shim for the Replit artifact static
// service, which cannot configure response headers for Autoscale deployments.
// The application registers this root file only while visiting /projects.
const BUILDER_COI_KILL_SWITCH_PARAM = "builderCoi";
const BUILDER_COI_KILL_SWITCH_VALUE = "off";

function isBuilderNavigation(request, url) {
  return (
    request.mode === "navigate" &&
    (url.pathname === "/projects" || url.pathname.startsWith("/projects/"))
  );
}

function hasKillSwitch(url) {
  return url.searchParams.get(BUILDER_COI_KILL_SWITCH_PARAM) === BUILDER_COI_KILL_SWITCH_VALUE;
}

async function withBuilderIsolationHeaders(request) {
  const response = await fetch(request);
  // Opaque/error responses cannot be reconstructed safely. Passing them
  // through preserves the browser's normal failure behavior.
  if (!response || response.type === "opaque" || response.status === 0) {
    return response;
  }

  const headers = new Headers(response.headers);
  headers.set("Cross-Origin-Opener-Policy", "same-origin");
  headers.set("Cross-Origin-Embedder-Policy", "credentialless");

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || !isBuilderNavigation(event.request, url)) {
    return;
  }

  // Escape hatch: this navigation goes directly to the network without added
  // headers, and removes this worker for subsequent navigations.
  if (hasKillSwitch(url)) {
    event.waitUntil(self.registration.unregister());
    return;
  }

  event.respondWith(withBuilderIsolationHeaders(event.request));
});
