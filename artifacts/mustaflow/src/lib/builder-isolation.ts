const BUILDER_ISOLATION_RELOAD_KEY = "mustaflow:builder-isolation-reload";

type BuilderIsolationWindow = Pick<Window, "crossOriginIsolated" | "location" | "sessionStorage">;

/**
 * Builder routes are reached through client-side navigation as well as direct
 * document requests. A SPA transition from a non-isolated page cannot acquire
 * COOP/COEP retroactively, so reload the Builder document once at its final
 * /projects URL. The session marker prevents a loop if the deployment headers
 * are temporarily unavailable.
 */
export function shouldReloadForBuilderIsolation(browser: BuilderIsolationWindow): boolean {
  if (browser.crossOriginIsolated) return false;

  try {
    return browser.sessionStorage.getItem(BUILDER_ISOLATION_RELOAD_KEY) !== browser.location.pathname;
  } catch {
    return false;
  }
}

export function reloadForBuilderIsolation(browser: BuilderIsolationWindow): void {
  try {
    browser.sessionStorage.setItem(BUILDER_ISOLATION_RELOAD_KEY, browser.location.pathname);
  } catch {
    return;
  }
  browser.location.reload();
}

export function clearBuilderIsolationReload(browser: BuilderIsolationWindow): void {
  if (!browser.crossOriginIsolated) return;
  try {
    browser.sessionStorage.removeItem(BUILDER_ISOLATION_RELOAD_KEY);
  } catch {
    // Storage can be unavailable in hardened browser contexts. Isolation is
    // already active, so there is nothing else to do.
  }
}
