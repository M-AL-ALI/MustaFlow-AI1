import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { isBuilderCoiKillSwitch, prepareBuilderIsolation } from "../builder-isolation";

const repoRoot = path.resolve(__dirname, "../../../../..");
const replitConfig = readFileSync(path.join(repoRoot, ".replit"), "utf8");
const frontendArtifact = readFileSync(
  path.join(repoRoot, "artifacts/mustaflow/.replit-artifact/artifact.toml"),
  "utf8",
);
const apiArtifact = readFileSync(
  path.join(repoRoot, "artifacts/api-server/.replit-artifact/artifact.toml"),
  "utf8",
);
const viteConfig = readFileSync(path.join(repoRoot, "artifacts/mustaflow/vite.config.ts"), "utf8");
const serviceWorkerSource = readFileSync(
  path.join(repoRoot, "artifacts/mustaflow/public/builder-coi-sw.js"),
  "utf8",
);

type HeaderEntry = {
  path: string;
  name: string;
  value: string;
};

function readResponseHeaders(source: string): HeaderEntry[] {
  return Array.from(
    source.matchAll(
      /\[\[deployment\.responseHeaders\]\]\s*path = "([^"]+)"\s*name = "([^"]+)"\s*value = "([^"]+)"/g,
    ),
    (match) => ({ path: match[1]!, name: match[2]!, value: match[3]! }),
  );
}

function fakeBrowser({
  isolated,
  pathname = "/projects/33",
  search = "",
  marker,
}: {
  isolated: boolean;
  pathname?: string;
  search?: string;
  marker?: string;
}) {
  const storage = new Map<string, string>();
  if (marker) storage.set("mustaflow:builder-isolation-reload", marker);
  const reload = vi.fn();
  return {
    browser: {
      crossOriginIsolated: isolated,
      location: { pathname, search, reload },
      sessionStorage: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value),
        removeItem: (key: string) => storage.delete(key),
      },
    } as unknown as Window,
    reload,
    storage,
  };
}

function fakeServiceWorkers(registrations: ServiceWorkerRegistration[] = []) {
  return {
    register: vi.fn().mockResolvedValue({}),
    ready: Promise.resolve({}),
    getRegistrations: vi.fn().mockResolvedValue(registrations),
  } as unknown as ServiceWorkerContainer;
}

function loadServiceWorker() {
  const listeners = new Map<string, (event: Record<string, unknown>) => void>();
  const unregister = vi.fn().mockResolvedValue(true);
  const skipWaiting = vi.fn().mockResolvedValue(undefined);
  const claim = vi.fn().mockResolvedValue(undefined);
  const fetchResponse = new Response("<html>Builder</html>", {
    status: 200,
    headers: { "Content-Type": "text/html" },
  });
  const fetchMock = vi.fn().mockResolvedValue(fetchResponse);
  const workerSelf = {
    location: { origin: "https://mustaflow.com" },
    registration: { unregister },
    clients: { claim },
    skipWaiting,
    addEventListener: vi.fn((name: string, listener: (event: Record<string, unknown>) => void) => {
      listeners.set(name, listener);
    }),
  };

  vm.runInNewContext(serviceWorkerSource, {
    self: workerSelf,
    URL,
    Headers,
    Response,
    fetch: fetchMock,
  });

  return { claim, fetchMock, listeners, skipWaiting, unregister };
}

describe("Builder WebContainer isolation", () => {
  it("proves the frontend is the static artifact while API and published routes use the API service", () => {
    expect(frontendArtifact).toContain('publicDir = "artifacts/mustaflow/dist/public"');
    expect(frontendArtifact).toContain('serve = "static"');
    expect(frontendArtifact).toContain('paths = [ "/" ]');
    expect(apiArtifact).toContain('paths = ["/api", "/u"]');
    expect(apiArtifact).toContain("artifacts/api-server/dist/index.mjs");
  });

  it("retains Wave 5's harmless Static Deployment header rules", () => {
    const entries = readResponseHeaders(replitConfig);
    for (const route of ["/projects", "/projects/*", "/assets/*"]) {
      expect(entries).toContainEqual({
        path: route,
        name: "Cross-Origin-Opener-Policy",
        value: "same-origin",
      });
      expect(entries).toContainEqual({
        path: route,
        name: "Cross-Origin-Embedder-Policy",
        value: "credentialless",
      });
    }
    expect(entries.some((entry) => entry.path === "/*" || entry.path.startsWith("/api"))).toBe(
      false,
    );
  });

  it("keeps Vite headers aligned and allows an honest service-worker-only preview test", () => {
    expect(viteConfig).toContain('"Cross-Origin-Opener-Policy": "same-origin"');
    expect(viteConfig).toContain('"Cross-Origin-Embedder-Policy": "credentialless"');
    expect(viteConfig).toContain("headers: crossOriginIsolationHeaders");
    expect(viteConfig).toContain('name: "builder-isolation-preview-headers"');
    expect(viteConfig).toContain("BUILDER_PREVIEW_ISOLATION_HEADERS");
  });

  it("registers only on an unisolated Builder route and reloads exactly once", async () => {
    const workers = fakeServiceWorkers();
    const first = fakeBrowser({ isolated: false });
    await expect(prepareBuilderIsolation(first.browser, workers)).resolves.toBe("reloading");
    expect(workers.register).toHaveBeenCalledWith("/builder-coi-sw.js", {
      scope: "/",
      updateViaCache: "none",
    });
    expect(first.reload).toHaveBeenCalledOnce();
    expect(first.storage.get("mustaflow:builder-isolation-reload")).toBe("sw-v1:/projects/33");

    const second = fakeBrowser({
      isolated: false,
      marker: "sw-v1:/projects/33",
    });
    await expect(prepareBuilderIsolation(second.browser, workers)).resolves.toBe("ready");
    expect(second.reload).not.toHaveBeenCalled();

    const nonBuilderWorkers = fakeServiceWorkers();
    const home = fakeBrowser({ isolated: false, pathname: "/" });
    await expect(prepareBuilderIsolation(home.browser, nonBuilderWorkers)).resolves.toBe("ready");
    expect(nonBuilderWorkers.register).not.toHaveBeenCalled();
  });

  it("clears stale markers without registering when isolation is already active", async () => {
    const workers = fakeServiceWorkers();
    const isolated = fakeBrowser({
      isolated: true,
      marker: "sw-v1:/projects/33",
    });
    await expect(prepareBuilderIsolation(isolated.browser, workers)).resolves.toBe("ready");
    expect(workers.register).not.toHaveBeenCalled();
    expect(isolated.storage.has("mustaflow:builder-isolation-reload")).toBe(false);
  });

  it("provides a query kill switch that unregisters only the Builder worker", async () => {
    const builderUnregister = vi.fn().mockResolvedValue(true);
    const otherUnregister = vi.fn().mockResolvedValue(true);
    const registration = (scriptURL: string, unregister: () => Promise<boolean>) =>
      ({
        active: { scriptURL },
        installing: null,
        waiting: null,
        unregister,
      }) as unknown as ServiceWorkerRegistration;
    const workers = fakeServiceWorkers([
      registration("https://mustaflow.com/builder-coi-sw.js", builderUnregister),
      registration("https://mustaflow.com/other-sw.js", otherUnregister),
    ]);
    const browser = fakeBrowser({
      isolated: false,
      search: "?builderCoi=off",
      marker: "sw-v1:/projects/33",
    });

    expect(isBuilderCoiKillSwitch("?builderCoi=off")).toBe(true);
    await expect(prepareBuilderIsolation(browser.browser, workers)).resolves.toBe("ready");
    expect(builderUnregister).toHaveBeenCalledOnce();
    expect(otherUnregister).not.toHaveBeenCalled();
    expect(workers.register).not.toHaveBeenCalled();
    expect(browser.storage.has("mustaflow:builder-isolation-reload")).toBe(false);
  });

  it("injects credentialless COOP/COEP only into Builder document navigations", async () => {
    const { fetchMock, listeners } = loadServiceWorker();
    const fetchListener = listeners.get("fetch");
    expect(fetchListener).toBeTypeOf("function");

    let responsePromise: Promise<Response> | undefined;
    fetchListener?.({
      request: {
        mode: "navigate",
        url: "https://mustaflow.com/projects/33",
      },
      respondWith: (response: Promise<Response>) => {
        responsePromise = response;
      },
      waitUntil: vi.fn(),
    });
    const response = await responsePromise;
    expect(response?.headers.get("Cross-Origin-Opener-Policy")).toBe("same-origin");
    expect(response?.headers.get("Cross-Origin-Embedder-Policy")).toBe("credentialless");
    expect(fetchMock).toHaveBeenCalledOnce();

    for (const pathname of [
      "/",
      "/assets/index.js",
      "/api/me/preferences",
      "/api/p/towing",
      "/sign-in",
      "/sign-up",
      "/ora",
    ]) {
      const respondWith = vi.fn();
      fetchListener?.({
        request: { mode: "navigate", url: `https://mustaflow.com${pathname}` },
        respondWith,
        waitUntil: vi.fn(),
      });
      expect(respondWith, pathname).not.toHaveBeenCalled();
    }
  });

  it("activates immediately and claims already-open same-origin tabs", () => {
    const { claim, listeners, skipWaiting } = loadServiceWorker();
    const installWaitUntil = vi.fn();
    const activateWaitUntil = vi.fn();

    listeners.get("install")?.({ waitUntil: installWaitUntil });
    listeners.get("activate")?.({ waitUntil: activateWaitUntil });

    expect(skipWaiting).toHaveBeenCalledOnce();
    expect(installWaitUntil).toHaveBeenCalledOnce();
    expect(claim).toHaveBeenCalledOnce();
    expect(activateWaitUntil).toHaveBeenCalledOnce();
  });

  it("bypasses the kill-switch navigation and self-unregisters", () => {
    const { listeners, unregister } = loadServiceWorker();
    const respondWith = vi.fn();
    const waitUntil = vi.fn();
    listeners.get("fetch")?.({
      request: {
        mode: "navigate",
        url: "https://mustaflow.com/projects/33?builderCoi=off",
      },
      respondWith,
      waitUntil,
    });
    expect(respondWith).not.toHaveBeenCalled();
    expect(unregister).toHaveBeenCalledOnce();
    expect(waitUntil).toHaveBeenCalledOnce();
  });
});
