import { describe, expect, it, vi } from "vitest";
import {
  BUILDER_CHUNK_REFRESHING_MESSAGE,
  BuilderChunkReloadPendingError,
  attemptBuilderChunkRecovery,
  builderChunkFailureRecord,
  cacheBustedChunkUrl,
  clearBuilderChunkFailure,
  chunkAssetUrlFromError,
  chunkFailureDiagnostic,
  inspectBuilderChunkAsset,
  isBuilderChunkLoadFailure,
  persistBuilderChunkFailure,
  readBuilderChunkFailure,
  retryBuilderChunkImport,
  showBuilderChunkRefreshing,
} from "./builder-chunk-recovery";

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => {
      values.delete(key);
    },
    setItem: (key, value) => values.set(key, value),
  };
}

const chunkFailure = new TypeError(
  "Failed to fetch dynamically imported module: https://www.mustaflow.com/assets/_id_-C9c46yz6.js",
);

describe("Builder chunk recovery", () => {
  it("retries a transient lazy-chunk failure once with a cache-busted URL", async () => {
    const expectedModule = { default: () => null };
    const importer = vi.fn().mockRejectedValueOnce(chunkFailure);
    const importModule = vi.fn().mockResolvedValueOnce(expectedModule);
    const waitBeforeRetry = vi.fn().mockResolvedValue(undefined);
    const reload = vi.fn();

    await expect(
      retryBuilderChunkImport(importer, {
        pathname: "/projects/44",
        origin: "https://www.mustaflow.com",
        storage: memoryStorage(),
        reload,
        importModule,
        waitBeforeRetry,
        showRefreshing: vi.fn(),
        scheduleReload: (run) => run(),
        retryToken: () => "transient-lab",
      }),
    ).resolves.toBe(expectedModule);

    expect(importer).toHaveBeenCalledOnce();
    expect(importModule).toHaveBeenCalledWith(
      "https://www.mustaflow.com/assets/_id_-C9c46yz6.js?mustaflow_chunk_retry=transient-lab",
    );
    expect(waitBeforeRetry).toHaveBeenCalledOnce();
    expect(reload).not.toHaveBeenCalled();
  });

  it("retries a failed CSS preload as a stylesheet instead of importing CSS as JavaScript", async () => {
    const expectedModule = { default: () => null };
    const cssFailure = new TypeError(
      "Unable to preload CSS for https://www.mustaflow.com/assets/_id_-DOOs4slz.css",
    );
    const importer = vi
      .fn()
      .mockRejectedValueOnce(cssFailure)
      .mockResolvedValueOnce(expectedModule);
    const importModule = vi.fn();
    const loadStylesheet = vi.fn().mockResolvedValue(undefined);

    await expect(
      retryBuilderChunkImport(importer, {
        pathname: "/projects/51",
        origin: "https://www.mustaflow.com",
        storage: memoryStorage(),
        importModule,
        loadStylesheet,
        waitBeforeRetry: vi.fn().mockResolvedValue(undefined),
        retryToken: () => "css-propagation",
      }),
    ).resolves.toBe(expectedModule);

    expect(loadStylesheet).toHaveBeenCalledWith(
      "https://www.mustaflow.com/assets/_id_-DOOs4slz.css?mustaflow_chunk_retry=css-propagation",
    );
    expect(importModule).not.toHaveBeenCalled();
    expect(importer).toHaveBeenCalledTimes(2);
  });

  it("clears a stale reload guard after the route chunk loads", async () => {
    const storage = memoryStorage();
    const removeItem = vi.spyOn(storage, "removeItem");

    await expect(
      retryBuilderChunkImport(vi.fn().mockResolvedValue({ default: () => null }), {
        pathname: "/projects/51",
        storage,
      }),
    ).resolves.toBeDefined();

    expect(removeItem).toHaveBeenCalledWith("mustaflow:builder-chunk-recovery:v2:/projects/51");
  });

  it("requests exactly one guarded reload when the retry also fails", async () => {
    const storage = memoryStorage();
    const reload = vi.fn();
    const showRefreshing = vi.fn();
    const runtime = {
      pathname: "/projects/44",
      origin: "https://www.mustaflow.com",
      storage,
      reload,
      importModule: vi.fn().mockRejectedValue(new TypeError("still unavailable")),
      waitBeforeRetry: vi.fn().mockResolvedValue(undefined),
      showRefreshing,
      scheduleReload: (run: () => void) => run(),
      retryToken: () => "persistent-lab",
      inspectAsset: vi.fn().mockResolvedValue({
        outcome: "response" as const,
        status: 503,
        mediaType: "other" as const,
      }),
    };

    await expect(
      retryBuilderChunkImport(vi.fn().mockRejectedValue(chunkFailure), runtime),
    ).rejects.toBeInstanceOf(BuilderChunkReloadPendingError);
    await expect(
      retryBuilderChunkImport(vi.fn().mockRejectedValue(chunkFailure), runtime),
    ).rejects.toMatchObject({
      name: "BuilderChunkRecoveryError",
      message:
        "NabuFlow could not finish loading this workspace. [retry TypeError: Builder asset failed to load.]",
    });

    expect(showRefreshing).toHaveBeenCalledOnce();
    expect(reload).toHaveBeenCalledOnce();
    expect(readBuilderChunkFailure(storage, "/projects/44")).toEqual({
      version: 1,
      capturedAt: expect.any(String),
      routeScope: "project-workspace",
      stage: "retry",
      errorClass: "TypeError",
      message: "Builder asset failed to load.",
      assetPath: "/assets/_id_-C9c46yz6.js",
      assetProbe: { outcome: "response", status: 503, mediaType: "other" },
    });
  });

  it("persists a bounded sanitized specimen without a stack or secret material", () => {
    const storage = memoryStorage();
    const restrictedPrefix = ["rk", "test", ""].join("_");
    const secret = `${restrictedPrefix}${"s".repeat(96)}`;
    const error = new TypeError(
      `Failed to fetch C:\\Users\\person\\project\\file.ts from https://www.mustaflow.com/assets/_id_-C9c46yz6.js?token=${secret} using Bearer ${secret}`,
    );
    error.stack = `STACK MUST NOT PERSIST ${secret}`;

    const persisted = persistBuilderChunkFailure(storage, {
      pathname: "/projects/51",
      stage: "retry",
      error,
      assetUrl: "https://www.mustaflow.com/assets/_id_-C9c46yz6.js?token=private",
      origin: "https://www.mustaflow.com",
      now: () => Date.UTC(2026, 7, 16, 19, 0, 0),
    });

    expect(persisted).toEqual({
      version: 1,
      capturedAt: "2026-08-16T19:00:00.000Z",
      routeScope: "project-workspace",
      stage: "retry",
      errorClass: "TypeError",
      message: "Builder asset failed to load.",
      assetPath: "/assets/_id_-C9c46yz6.js",
      assetProbe: { outcome: "unavailable" },
    });
    const raw = JSON.stringify(readBuilderChunkFailure(storage, "/projects/51"));
    expect(raw).not.toContain(secret);
    expect(raw).not.toContain("STACK MUST NOT PERSIST");
    expect(raw).not.toContain("person");
    expect(raw).not.toContain("token=private");
  });

  it("rejects a tampered persisted specimen and clears only after recovery succeeds", async () => {
    const storage = memoryStorage();
    storage.setItem(
      "mustaflow:builder-chunk-failure:v1:project-workspace",
      JSON.stringify({
        version: 1,
        capturedAt: new Date().toISOString(),
        routeScope: "project-workspace",
        stage: "retry",
        errorClass: "TypeError",
        message: "tampered",
        assetPath: "https://unexpected.example/private.js",
        assetProbe: { outcome: "unavailable" },
      }),
    );
    expect(readBuilderChunkFailure(storage, "/projects/51")).toBeNull();

    persistBuilderChunkFailure(storage, {
      pathname: "/projects/51",
      stage: "global",
      error: chunkFailure,
      origin: "https://www.mustaflow.com",
    });
    expect(readBuilderChunkFailure(storage, "/projects/51")).not.toBeNull();

    await expect(
      retryBuilderChunkImport(vi.fn().mockResolvedValue({ default: () => null }), {
        pathname: "/projects/51",
        storage,
      }),
    ).resolves.toBeDefined();
    expect(readBuilderChunkFailure(storage, "/projects/51")).toBeNull();

    clearBuilderChunkFailure(storage, "/projects/51");
  });

  it("constructs only content-free failure records for hashed same-origin assets", () => {
    expect(
      builderChunkFailureRecord({
        pathname: "/projects/51",
        stage: "global",
        error: new Error("Import failed"),
        assetUrl: "https://unexpected.example/assets/_id_-C9c46yz6.js",
        origin: "https://www.mustaflow.com",
        now: () => 0,
      }),
    ).toMatchObject({
      assetPath: null,
      errorClass: "Error",
      message: "Builder asset failed to load.",
      assetProbe: { outcome: "unavailable" },
    });
  });

  it("probes a failing asset with a content-free HEAD classification", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      new Response(null, {
        status: 200,
        headers: { "content-type": "text/javascript; charset=utf-8" },
      }),
    );

    await expect(
      inspectBuilderChunkAsset("https://www.mustaflow.com/assets/_id_-C9c46yz6.js?private=value", {
        origin: "https://www.mustaflow.com",
        fetcher,
      }),
    ).resolves.toEqual({ outcome: "response", status: 200, mediaType: "javascript" });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledWith(
      "https://www.mustaflow.com/assets/_id_-C9c46yz6.js",
      expect.objectContaining({ method: "HEAD", cache: "no-store" }),
    );
  });

  it("classifies probe transport failure without retaining its message", async () => {
    const fetcher = vi
      .fn()
      .mockRejectedValue(new TypeError("private hostname and user supplied text"));

    await expect(
      inspectBuilderChunkAsset("https://www.mustaflow.com/assets/_id_-C9c46yz6.js", {
        origin: "https://www.mustaflow.com",
        fetcher,
      }),
    ).resolves.toEqual({ outcome: "transport-error", errorClass: "TypeError" });
  });

  it("never persists project identity or free-form failure text", () => {
    const storage = memoryStorage();
    const freeform = "private project title and user supplied text";

    persistBuilderChunkFailure(storage, {
      pathname: "/projects/private-project-51",
      stage: "global",
      error: new Error(freeform),
      assetUrl: "https://www.mustaflow.com/assets/_id_-C9c46yz6.js",
      origin: "https://www.mustaflow.com",
    });

    const persisted = storage.getItem("mustaflow:builder-chunk-failure:v1:project-workspace");
    expect(persisted).toContain('"routeScope":"project-workspace"');
    expect(persisted).not.toContain("private-project-51");
    expect(persisted).not.toContain(freeform);
  });

  it("canonicalizes the retry diagnostic instead of retaining free-form content", () => {
    const restrictedPrefix = ["rk", "test", ""].join("_");
    const secret = `${restrictedPrefix}${"x".repeat(96)}`;
    const diagnostic = chunkFailureDiagnostic(
      new TypeError(
        `Failed at https://www.mustaflow.com/assets/chunk.js?token=${secret} with ${secret}`,
      ),
    );

    expect(diagnostic).toBe("[retry TypeError: Builder asset failed to load.]");
    expect(diagnostic).not.toContain(secret);
    expect(diagnostic).not.toContain("https://");
  });

  it("recognizes the production failure and extracts its requested chunk", () => {
    expect(chunkAssetUrlFromError(chunkFailure)).toBe(
      "https://www.mustaflow.com/assets/_id_-C9c46yz6.js",
    );
    expect(
      isBuilderChunkLoadFailure({
        pathname: "/projects/44",
        error: chunkFailure,
      }),
    ).toBe(true);
  });

  it("never reloads twice for the same route in one browser session", () => {
    const storage = memoryStorage();
    const reload = vi.fn();
    const failure = {
      pathname: "/projects/40",
      error: chunkFailure,
    };

    expect(attemptBuilderChunkRecovery(failure, storage, reload)).toBe(true);
    expect(attemptBuilderChunkRecovery(failure, storage, reload)).toBe(false);
    expect(reload).toHaveBeenCalledOnce();
  });

  it("recognizes a hashed asset/MIME failure but ignores normal runtime errors", () => {
    expect(
      isBuilderChunkLoadFailure({
        pathname: "/projects/40",
        error: new Error(
          'Expected a JavaScript module script but the server responded with a MIME type of "text/html".',
        ),
        assetUrl: "/assets/_id_-CzmhkXlx.js",
      }),
    ).toBe(true);
    expect(
      isBuilderChunkLoadFailure({
        pathname: "/projects/40",
        error: new TypeError("Cannot read properties of undefined (reading 'title')"),
      }),
    ).toBe(false);
  });

  it("never recovers outside NabuFlow Builder routes", () => {
    const storage = memoryStorage();
    const reload = vi.fn();

    expect(
      attemptBuilderChunkRecovery(
        {
          pathname: "/ora",
          error: chunkFailure,
        },
        storage,
        reload,
      ),
    ).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });

  it("rejects cross-origin cache-busted imports", () => {
    expect(() =>
      cacheBustedChunkUrl(
        "https://unexpected.example/assets/_id_-C9c46yz6.js",
        "blocked",
        "https://www.mustaflow.com",
      ),
    ).toThrow("outside the NabuFlow asset origin");
  });

  it("shows one calm non-blank refresh status", () => {
    showBuilderChunkRefreshing(document);
    showBuilderChunkRefreshing(document);

    const statuses = document.querySelectorAll("[data-builder-chunk-refreshing]");
    expect(statuses).toHaveLength(1);
    expect(statuses[0]).toHaveTextContent(BUILDER_CHUNK_REFRESHING_MESSAGE);
    expect(statuses[0]).toHaveAttribute("role", "status");
  });
});
