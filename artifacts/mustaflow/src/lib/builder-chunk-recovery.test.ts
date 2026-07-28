import { describe, expect, it, vi } from "vitest";
import {
  attemptBuilderChunkRecovery,
  isBuilderChunkLoadFailure,
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
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, value),
  };
}

describe("Builder stale chunk recovery", () => {
  it("recovers once from a lazy chunk failure and never reloads twice for that route", () => {
    const storage = memoryStorage();
    const reload = vi.fn();
    const failure = {
      pathname: "/projects/40",
      error: new TypeError(
        "Failed to fetch dynamically imported module: https://www.mustaflow.com/assets/_id_-old.js",
      ),
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

  it("never recovers outside Builder routes", () => {
    const storage = memoryStorage();
    const reload = vi.fn();

    expect(
      attemptBuilderChunkRecovery(
        {
          pathname: "/ora",
          error: new Error("Failed to fetch dynamically imported module"),
        },
        storage,
        reload,
      ),
    ).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });
});
