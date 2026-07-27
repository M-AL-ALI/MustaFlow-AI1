const BUILDER_ISOLATION_RELOAD_KEY = "mustaflow:builder-isolation-reload";
const BUILDER_ISOLATION_RELOAD_VERSION = "sw-v1";
const BUILDER_COI_SERVICE_WORKER_PATH = "/builder-coi-sw.js";
const BUILDER_COI_KILL_SWITCH_PARAM = "builderCoi";

type BuilderIsolationWindow = Pick<Window, "crossOriginIsolated" | "location" | "sessionStorage">;

type BuilderServiceWorkers = Pick<
  ServiceWorkerContainer,
  "getRegistrations" | "ready" | "register"
>;

export type BuilderIsolationOutcome = "ready" | "reloading";

function isBuilderRoute(pathname: string): boolean {
  return pathname === "/projects" || pathname.startsWith("/projects/");
}

function reloadMarker(pathname: string): string {
  // Versioning means a marker left by Wave 5's server-header attempt does not
  // suppress the single reload needed to put this service worker in control.
  return `${BUILDER_ISOLATION_RELOAD_VERSION}:${pathname}`;
}

function removeReloadMarker(browser: BuilderIsolationWindow): void {
  try {
    browser.sessionStorage.removeItem(BUILDER_ISOLATION_RELOAD_KEY);
  } catch {
    // Storage can be unavailable in hardened browser contexts.
  }
}

export function isBuilderCoiKillSwitch(search: string): boolean {
  try {
    return new URLSearchParams(search).get(BUILDER_COI_KILL_SWITCH_PARAM) === "off";
  } catch {
    return false;
  }
}

function registrationUsesBuilderCoi(registration: ServiceWorkerRegistration): boolean {
  return [registration.active, registration.installing, registration.waiting].some((worker) => {
    if (!worker) return false;
    try {
      return new URL(worker.scriptURL).pathname === BUILDER_COI_SERVICE_WORKER_PATH;
    } catch {
      return false;
    }
  });
}

async function unregisterBuilderCoi(serviceWorkers: BuilderServiceWorkers): Promise<void> {
  try {
    const registrations = await serviceWorkers.getRegistrations();
    await Promise.all(
      registrations
        .filter(registrationUsesBuilderCoi)
        .map((registration) => registration.unregister()),
    );
  } catch {
    // The kill switch must remain fail-safe even when the browser blocks the
    // Service Worker API. The worker also self-unregisters when it sees the
    // kill-switch query on a Builder navigation.
  }
}

/**
 * Prepare cross-origin isolation for a Builder document.
 *
 * Replit's Autoscale artifact static service does not expose response-header
 * configuration, so a root-scoped service worker adds COOP/COEP to Builder
 * navigation responses. Registration is gated to /projects routes. Once the
 * worker is active, exactly one versioned reload lets it serve the document;
 * if isolation is still unavailable after that reload, Builder continues with
 * the existing static/WebContainer-unsupported fallback and never loops.
 *
 * Production escape hatch:
 *   /projects/123?builderCoi=off
 * bypasses and unregisters only /builder-coi-sw.js.
 */
export async function prepareBuilderIsolation(
  browser: BuilderIsolationWindow,
  serviceWorkers?: BuilderServiceWorkers,
): Promise<BuilderIsolationOutcome> {
  if (!isBuilderRoute(browser.location.pathname)) return "ready";

  if (isBuilderCoiKillSwitch(browser.location.search)) {
    removeReloadMarker(browser);
    if (serviceWorkers) await unregisterBuilderCoi(serviceWorkers);
    return "ready";
  }

  if (browser.crossOriginIsolated) {
    removeReloadMarker(browser);
    return "ready";
  }

  if (!serviceWorkers) return "ready";

  const marker = reloadMarker(browser.location.pathname);
  try {
    await serviceWorkers.register(BUILDER_COI_SERVICE_WORKER_PATH, {
      scope: "/",
      updateViaCache: "none",
    });
    // install + skipWaiting + clients.claim must finish before the reload so
    // the worker can decorate the next document response.
    await serviceWorkers.ready;

    if (browser.sessionStorage.getItem(BUILDER_ISOLATION_RELOAD_KEY) === marker) {
      return "ready";
    }
    browser.sessionStorage.setItem(BUILDER_ISOLATION_RELOAD_KEY, marker);
  } catch {
    // Registration/storage failures fail open to today's preview fallback.
    return "ready";
  }

  browser.location.reload();
  return "reloading";
}
