import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  clearBuilderIsolationReload,
  reloadForBuilderIsolation,
  shouldReloadForBuilderIsolation,
} from "../builder-isolation";

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
  marker,
}: {
  isolated: boolean;
  pathname?: string;
  marker?: string;
}) {
  const storage = new Map<string, string>();
  if (marker) storage.set("mustaflow:builder-isolation-reload", marker);
  const reload = vi.fn();
  return {
    browser: {
      crossOriginIsolated: isolated,
      location: { pathname, reload },
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

describe("Builder WebContainer isolation", () => {
  it("proves the frontend is the static artifact while API and published routes use the API service", () => {
    expect(frontendArtifact).toContain('publicDir = "artifacts/mustaflow/dist/public"');
    expect(frontendArtifact).toContain('serve = "static"');
    expect(frontendArtifact).toContain('paths = [ "/" ]');
    expect(apiArtifact).toContain('paths = ["/api", "/u"]');
    expect(apiArtifact).toContain('artifacts/api-server/dist/index.mjs');
  });

  it("configures credentialless isolation for Builder documents and static assets only", () => {
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

  it("keeps Vite development and production-preview headers aligned", () => {
    expect(viteConfig).toContain('"Cross-Origin-Opener-Policy": "same-origin"');
    expect(viteConfig).toContain('"Cross-Origin-Embedder-Policy": "credentialless"');
    expect(viteConfig).toContain("headers: crossOriginIsolationHeaders");
    expect(viteConfig).toContain('name: "builder-isolation-preview-headers"');
    expect(viteConfig).toContain('pathname.startsWith("/projects/")');
    expect(viteConfig).toContain('pathname.startsWith("/assets/")');
  });

  it("reloads once after a SPA transition into Builder and does not loop", () => {
    const first = fakeBrowser({ isolated: false });
    expect(shouldReloadForBuilderIsolation(first.browser)).toBe(true);
    reloadForBuilderIsolation(first.browser);
    expect(first.reload).toHaveBeenCalledOnce();
    expect(first.storage.get("mustaflow:builder-isolation-reload")).toBe("/projects/33");

    const second = fakeBrowser({
      isolated: false,
      marker: "/projects/33",
    });
    expect(shouldReloadForBuilderIsolation(second.browser)).toBe(false);
  });

  it("clears the reload marker once isolation is active", () => {
    const isolated = fakeBrowser({
      isolated: true,
      marker: "/projects/33",
    });
    expect(shouldReloadForBuilderIsolation(isolated.browser)).toBe(false);
    clearBuilderIsolationReload(isolated.browser);
    expect(isolated.storage.has("mustaflow:builder-isolation-reload")).toBe(false);
  });
});
