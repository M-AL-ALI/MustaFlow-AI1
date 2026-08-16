import { describe, expect, it, vi } from "vitest";
import {
  BUILDER_CHUNK_REFRESHING_MESSAGE,
  BuilderChunkReloadPendingError,
  attemptBuilderChunkRecovery,
  cacheBustedChunkUrl,
  chunkAssetUrlFromError,
  chunkFailureDiagnostic,
  isBuilderChunkLoadFailure,
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
    };

    await expect(
      retryBuilderChunkImport(vi.fn().mockRejectedValue(chunkFailure), runtime),
    ).rejects.toBeInstanceOf(BuilderChunkReloadPendingError);
    await expect(
      retryBuilderChunkImport(vi.fn().mockRejectedValue(chunkFailure), runtime),
    ).rejects.toMatchObject({
      name: "BuilderChunkRecoveryError",
      message:
        "NabuFlow could not finish loading this workspace. [retry TypeError: still unavailable]",
    });

    expect(showRefreshing).toHaveBeenCalledOnce();
    expect(reload).toHaveBeenCalledOnce();
  });

  it("bounds and redacts the retained retry diagnostic", () => {
    const restrictedPrefix = ["rk", "test", ""].join("_");
    const secret = `${restrictedPrefix}${"x".repeat(96)}`;
    const diagnostic = chunkFailureDiagnostic(
      new TypeError(
        `Failed at https://www.mustaflow.com/assets/chunk.js?token=${secret} with ${secret}`,
      ),
    );

    expect(diagnostic).toContain("[retry TypeError:");
    expect(diagnostic).toContain("https://www.mustaflow.com/assets/chunk.js?[redacted]");
    expect(diagnostic).not.toContain(secret);
    expect(diagnostic).toContain("[redacted]");
    expect(diagnostic.length).toBeLessThanOrEqual(520);
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
