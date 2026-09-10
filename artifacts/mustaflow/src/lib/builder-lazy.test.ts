// @vitest-environment jsdom
import type { ComponentProps } from "react";
import { beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  lazy: vi.fn<(loader: () => Promise<{ default: unknown }>) => void>(),
  importModule: vi.fn<(url: string) => Promise<unknown>>(),
  loadStylesheet: vi.fn<(url: string) => Promise<void>>(),
  waitBeforeRetry: vi.fn<() => Promise<void>>(),
  inspectAsset: vi.fn<() => Promise<{ outcome: "unavailable" }>>(),
  showRefreshing: vi.fn<() => void>(),
  scheduleReload: vi.fn<(reload: () => void) => void>(),
  reload: vi.fn<() => void>(),
  storage: new Map<string, string>(),
}));

// Observe React's public lazy-loader boundary without using React internals.
vi.mock("react", async (importOriginal) => {
  const react = await importOriginal<typeof import("react")>();
  return {
    ...react,
    lazy: (loader: Parameters<typeof react.lazy>[0]) => {
      mocks.lazy(loader);
      return react.lazy(loader);
    },
  };
});

// Keep the real recovery algorithm; replace only its browser/network effects.
vi.mock("./builder-chunk-recovery", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./builder-chunk-recovery")>();
  return {
    ...actual,
    retryBuilderChunkImport: <T>(importer: () => Promise<T>) =>
      actual.retryBuilderChunkImport(importer, {
        pathname: "/projects/60",
        origin: "https://workspace.example",
        storage: {
          getItem: (key) => mocks.storage.get(key) ?? null,
          setItem: (key, value) => {
            mocks.storage.set(key, value);
          },
          removeItem: (key) => {
            mocks.storage.delete(key);
          },
        },
        importModule: <Module>(url: string) => mocks.importModule(url) as Promise<Module>,
        loadStylesheet: mocks.loadStylesheet,
        waitBeforeRetry: mocks.waitBeforeRetry,
        inspectAsset: mocks.inspectAsset,
        showRefreshing: mocks.showRefreshing,
        scheduleReload: mocks.scheduleReload,
        reload: mocks.reload,
        retryToken: () => "selector-regression",
      }),
  };
});

import { builderLazy } from "./builder-lazy";

function NamedPanel(_props: { projectId: number }) {
  return null;
}

function OtherPanel() {
  return null;
}

function load(index = 0) {
  return mocks.lazy.mock.calls[index]![0]();
}

function initialChunkFailure() {
  return new TypeError(
    "Failed to fetch dynamically imported module: https://workspace.example/assets/named-panel-AbC12345.js",
  );
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.storage.clear();
  mocks.waitBeforeRetry.mockResolvedValue();
  mocks.loadStylesheet.mockResolvedValue();
  mocks.inspectAsset.mockResolvedValue({ outcome: "unavailable" });
});

describe("builderLazy module selection after recovery", () => {
  it("selects the named component after an initial raw-module success", async () => {
    const module = { NamedPanel, OtherPanel };
    const importer = vi.fn(async () => module);
    const select = vi.fn((loaded: typeof module) => loaded.NamedPanel);
    const LazyPanel = builderLazy(importer, select);
    expect(LazyPanel).toBeDefined();

    expectTypeOf<ComponentProps<typeof LazyPanel>>().toEqualTypeOf<{ projectId: number }>();
    expect(importer).not.toHaveBeenCalled();
    expect(select).not.toHaveBeenCalled();
    expect(await load()).toEqual({ default: NamedPanel });
    expect(importer).toHaveBeenCalledTimes(1);
    expect(select).toHaveBeenCalledExactlyOnceWith(module);
    expect(mocks.importModule).not.toHaveBeenCalled();
    expect(mocks.waitBeforeRetry).not.toHaveBeenCalled();
  });

  it("selects the named component from the raw cache-busted JS retry module", async () => {
    const recovered = { NamedPanel, OtherPanel };
    const importer = vi
      .fn<() => Promise<typeof recovered>>()
      .mockRejectedValue(initialChunkFailure());
    const select = vi.fn((module: typeof recovered) => module.NamedPanel);
    mocks.importModule.mockResolvedValue(recovered);

    builderLazy(importer, select);
    expect(await load()).toEqual({ default: NamedPanel });
    expect(importer).toHaveBeenCalledTimes(1);
    expect(select).toHaveBeenCalledExactlyOnceWith(recovered);
    expect(mocks.importModule).toHaveBeenCalledTimes(1);
    const retryUrl = new URL(mocks.importModule.mock.calls[0]![0]);
    expect(retryUrl.origin).toBe("https://workspace.example");
    expect(retryUrl.pathname).toBe("/assets/named-panel-AbC12345.js");
    expect(retryUrl.search).toContain("selector-regression");
    expect(mocks.waitBeforeRetry).toHaveBeenCalledTimes(1);
    expect(mocks.scheduleReload).not.toHaveBeenCalled();
  });

  it("does not select before a pending import settles", async () => {
    const module = { NamedPanel };
    let resolve!: (value: typeof module) => void;
    const pendingModule = new Promise<typeof module>((done) => {
      resolve = done;
    });
    const select = vi.fn((loaded: typeof module) => loaded.NamedPanel);
    builderLazy(() => pendingModule, select);
    const pending = load();

    expect(select).not.toHaveBeenCalled();
    resolve(module);
    expect(await pending).toEqual({ default: NamedPanel });
    expect(select).toHaveBeenCalledTimes(1);
  });

  it("preserves the default-export API, module identity and required props", async () => {
    const module = { default: NamedPanel };
    const importer = vi.fn(async () => module);
    const LazyPanel = builderLazy(importer);
    expect(LazyPanel).toBeDefined();

    expectTypeOf<ComponentProps<typeof LazyPanel>>().toEqualTypeOf<{ projectId: number }>();
    expect(await load()).toBe(module);
    expect(importer).toHaveBeenCalledTimes(1);
    expect(mocks.importModule).not.toHaveBeenCalled();
  });

  it("preserves default-export callers when recovery returns a raw module", async () => {
    const recovered = { default: NamedPanel };
    const importer = vi
      .fn<() => Promise<typeof recovered>>()
      .mockRejectedValue(initialChunkFailure());
    mocks.importModule.mockResolvedValue(recovered);
    builderLazy(importer);

    expect(await load()).toBe(recovered);
    expect(importer).toHaveBeenCalledTimes(1);
    expect(mocks.importModule).toHaveBeenCalledTimes(1);
    expect(mocks.scheduleReload).not.toHaveBeenCalled();
  });

  it("propagates a non-chunk import error without running the selector", async () => {
    const error = new Error("module evaluation failed");
    const importer = vi
      .fn<() => Promise<{ NamedPanel: typeof NamedPanel }>>()
      .mockRejectedValue(error);
    const select = vi.fn((module: { NamedPanel: typeof NamedPanel }) => module.NamedPanel);
    builderLazy(importer, select);

    await expect(load()).rejects.toBe(error);
    expect(importer).toHaveBeenCalledTimes(1);
    expect(select).not.toHaveBeenCalled();
    expect(mocks.importModule).not.toHaveBeenCalled();
    expect(mocks.scheduleReload).not.toHaveBeenCalled();
  });

  it("preserves the recovery failure path and never selects a missing module", async () => {
    const importer = vi
      .fn<() => Promise<{ NamedPanel: typeof NamedPanel }>>()
      .mockRejectedValue(initialChunkFailure());
    const select = vi.fn((module: { NamedPanel: typeof NamedPanel }) => module.NamedPanel);
    mocks.importModule.mockRejectedValue(new Error("retry failed"));
    builderLazy(importer, select);

    await expect(load()).rejects.toThrow();
    expect(importer).toHaveBeenCalledTimes(1);
    expect(mocks.importModule).toHaveBeenCalledTimes(1);
    expect(mocks.inspectAsset).toHaveBeenCalledTimes(1);
    expect(mocks.scheduleReload).toHaveBeenCalledTimes(1);
    expect(select).not.toHaveBeenCalled();
  });

  it("propagates selector errors without misclassifying them as chunk failures", async () => {
    const error = initialChunkFailure();
    const importer = vi.fn(async () => ({ NamedPanel }));
    const select = vi.fn((_module: { NamedPanel: typeof NamedPanel }): typeof NamedPanel => {
      throw error;
    });
    builderLazy(importer, select);

    await expect(load()).rejects.toBe(error);
    expect(importer).toHaveBeenCalledTimes(1);
    expect(select).toHaveBeenCalledTimes(1);
    expect(mocks.importModule).not.toHaveBeenCalled();
    expect(mocks.waitBeforeRetry).not.toHaveBeenCalled();
    expect(mocks.scheduleReload).not.toHaveBeenCalled();
  });
});
