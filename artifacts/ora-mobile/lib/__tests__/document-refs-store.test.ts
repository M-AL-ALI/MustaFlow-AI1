import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Unit suite for the persistent upload-ref cache (document-refs-store.ts).
 *
 * Purpose being guarded: "Revise the deck" typed after the app was fully
 * closed and reopened must still target the ORIGINAL uploaded file — parity
 * with the website's sessionStorage cache. The store must round-trip through
 * AsyncStorage, tolerate corrupt payloads, cap growth, and stay synchronous
 * for reads after a single async hydration.
 */

const storage = new Map<string, string>();

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: vi.fn((key: string) => Promise.resolve(storage.get(key) ?? null)),
    setItem: vi.fn((key: string, value: string) => {
      storage.set(key, value);
      return Promise.resolve();
    }),
    removeItem: vi.fn((key: string) => {
      storage.delete(key);
      return Promise.resolve();
    }),
    multiGet: vi.fn((keys: string[]) =>
      Promise.resolve(keys.map((k) => [k, storage.get(k) ?? null])),
    ),
  },
}));

import {
  __resetDocumentRefsStoreForTests,
  clearAllStoredDocumentRefs,
  DOC_REFS_STANDALONE_KEY,
  docRefsKey,
  getStoredDocumentRefs,
  loadDocumentRefsStore,
  storeDocumentRefs,
} from "../document-refs-store";

const STORAGE_KEY = "ora_doc_refs";

// Flush the fire-and-forget AsyncStorage writes queued by storeDocumentRefs.
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  storage.clear();
  __resetDocumentRefsStoreForTests();
});

describe("docRefsKey", () => {
  it("keys conversations as conv:<id> and everything else as standalone", () => {
    expect(docRefsKey(42)).toBe("conv:42");
    expect(docRefsKey(null)).toBe(DOC_REFS_STANDALONE_KEY);
    expect(docRefsKey(undefined)).toBe(DOC_REFS_STANDALONE_KEY);
  });
});

describe("round-trip persistence", () => {
  it("stores refs and restores them after a simulated app restart", async () => {
    await loadDocumentRefsStore();
    storeDocumentRefs("conv:7", ["ref-a", "ref-b"]);
    await flush();

    // Simulate a full restart: module state resets, AsyncStorage survives.
    __resetDocumentRefsStoreForTests();
    expect(getStoredDocumentRefs("conv:7")).toEqual([]);

    await loadDocumentRefsStore();
    expect(getStoredDocumentRefs("conv:7")).toEqual(["ref-a", "ref-b"]);
  });

  it("standalone refs survive a restart independently of conversation refs", async () => {
    await loadDocumentRefsStore();
    storeDocumentRefs(DOC_REFS_STANDALONE_KEY, ["pre-conv-ref"]);
    storeDocumentRefs("conv:1", ["conv-ref"]);
    await flush();

    __resetDocumentRefsStoreForTests();
    await loadDocumentRefsStore();
    expect(getStoredDocumentRefs(DOC_REFS_STANDALONE_KEY)).toEqual(["pre-conv-ref"]);
    expect(getStoredDocumentRefs("conv:1")).toEqual(["conv-ref"]);
  });

  it("storing an empty array deletes the key (standalone -> conversation migration)", async () => {
    await loadDocumentRefsStore();
    storeDocumentRefs(DOC_REFS_STANDALONE_KEY, ["ref-1"]);
    // Migration: move to the conversation key, clear standalone.
    storeDocumentRefs("conv:9", ["ref-1"]);
    storeDocumentRefs(DOC_REFS_STANDALONE_KEY, []);
    await flush();

    __resetDocumentRefsStoreForTests();
    await loadDocumentRefsStore();
    expect(getStoredDocumentRefs(DOC_REFS_STANDALONE_KEY)).toEqual([]);
    expect(getStoredDocumentRefs("conv:9")).toEqual(["ref-1"]);
  });
});

describe("caps and hygiene", () => {
  it("caps refs per key at the server max (5), keeping the most recent", async () => {
    await loadDocumentRefsStore();
    // Callers maintain newest-FIRST ordering ([newRef, ...prev]), so the cap
    // must keep the HEAD of the list — r1 is the newest ref here.
    storeDocumentRefs("conv:2", ["r1", "r2", "r3", "r4", "r5", "r6", "r7"]);
    expect(getStoredDocumentRefs("conv:2")).toEqual(["r1", "r2", "r3", "r4", "r5"]);
  });

  it("caps tracked keys at 20, evicting the oldest entries", async () => {
    await loadDocumentRefsStore();
    for (let i = 1; i <= 25; i++) storeDocumentRefs(`conv:${i}`, [`ref-${i}`]);
    expect(getStoredDocumentRefs("conv:1")).toEqual([]);
    expect(getStoredDocumentRefs("conv:25")).toEqual(["ref-25"]);
  });

  it("removes the storage key entirely when the map empties", async () => {
    await loadDocumentRefsStore();
    storeDocumentRefs("conv:3", ["ref"]);
    await flush();
    expect(storage.has(STORAGE_KEY)).toBe(true);
    storeDocumentRefs("conv:3", []);
    await flush();
    expect(storage.has(STORAGE_KEY)).toBe(false);
  });

  it("clearAllStoredDocumentRefs wipes memory and disk", async () => {
    await loadDocumentRefsStore();
    storeDocumentRefs("conv:4", ["ref"]);
    await flush();
    clearAllStoredDocumentRefs();
    await flush();
    expect(getStoredDocumentRefs("conv:4")).toEqual([]);
    expect(storage.has(STORAGE_KEY)).toBe(false);
  });
});

describe("corrupt or hostile payloads", () => {
  it("ignores non-JSON payloads and starts empty", async () => {
    storage.set(STORAGE_KEY, "not json {{{");
    await loadDocumentRefsStore();
    expect(getStoredDocumentRefs("conv:5")).toEqual([]);
  });

  it("drops non-array values and non-string refs while keeping valid entries", async () => {
    storage.set(
      STORAGE_KEY,
      JSON.stringify({
        "conv:6": ["good-ref", 42, null, "another"],
        bogus: "not-an-array",
        nested: { x: 1 },
      }),
    );
    await loadDocumentRefsStore();
    expect(getStoredDocumentRefs("conv:6")).toEqual(["good-ref", "another"]);
    expect(getStoredDocumentRefs("bogus")).toEqual([]);
    expect(getStoredDocumentRefs("nested")).toEqual([]);
  });

  it("ignores array/scalar top-level payloads", async () => {
    storage.set(STORAGE_KEY, JSON.stringify(["not", "a", "map"]));
    await loadDocumentRefsStore();
    expect(getStoredDocumentRefs(DOC_REFS_STANDALONE_KEY)).toEqual([]);
  });
});

describe("hydration behavior", () => {
  it("loadDocumentRefsStore is idempotent (single read, cached promise)", async () => {
    const AsyncStorage = (await import("@react-native-async-storage/async-storage")).default;
    vi.mocked(AsyncStorage.getItem).mockClear();
    await loadDocumentRefsStore();
    await loadDocumentRefsStore();
    await loadDocumentRefsStore();
    expect(vi.mocked(AsyncStorage.getItem).mock.calls.length).toBe(1);
  });
});
