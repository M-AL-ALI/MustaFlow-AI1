import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectReviewClerk } from "./project-review-account-fence";

vi.mock("@workspace/api-client-react", () => ({ getAuthToken: vi.fn() }));
import { getAuthToken } from "@workspace/api-client-react";
import { createAssetUploadLifetime, uploadAccountAsset, uploadProjectAsset } from "./asset-upload";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const listeners = new Set<(resources: { user?: { id: string } | null }) => void>();
let clerk: ProjectReviewClerk;
const images: DeferredImage[] = [];
const puts: TestRequest[] = [];
const calls: Array<{ url: string; init: RequestInit; account: string | undefined }> = [];

class DeferredImage {
  width = 100;
  height = 100;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  src = "";
  constructor() {
    images.push(this);
  }
}

class TestRequest {
  url = "";
  body: Blob | null = null;
  withCredentials = false;
  headers = new Headers();
  status = 200;
  responseText = "{}";
  aborted = false;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  upload = {
    onprogress: null as
      | ((event: { lengthComputable: boolean; loaded: number; total: number }) => void)
      | null,
  };
  open(_method: string, url: string) {
    this.url = url;
  }
  setRequestHeader(name: string, value: string) {
    this.headers.set(name, value);
  }
  send(body: Blob) {
    this.body = body;
    puts.push(this);
  }
  abort() {
    this.aborted = true;
    this.onabort?.();
  }
  complete(status = 200, body = {}) {
    this.status = status;
    this.responseText = JSON.stringify(body);
    this.onload?.();
  }
}

function switchAccount(id: string | null, notify = true) {
  clerk.user = id ? { id } : null;
  if (notify) for (const listener of [...listeners]) listener({ user: clerk.user });
}

function requestInput(signal?: AbortSignal) {
  return {
    file: new File(["account A data"], "note.txt", { type: "text/plain" }),
    source: "picker" as const,
    signal,
  };
}

function reservation() {
  return { assetId: 901, uploadUrl: "/api/assets/901/content" };
}

function observe<T>(promise: Promise<T>) {
  return promise.then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
}

beforeEach(() => {
  vi.useRealTimers();
  vi.resetAllMocks();
  listeners.clear();
  images.length = puts.length = calls.length = 0;
  clerk = {
    loaded: true,
    user: { id: "account-A" },
    addListener(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  vi.stubGlobal("Clerk", clerk);
  vi.stubGlobal("__E2E_TEST_USER__", undefined);
  vi.stubGlobal("Image", DeferredImage);
  vi.stubGlobal("XMLHttpRequest", TestRequest);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init, account: clerk.user?.id });
      return { ok: true, json: async () => reservation() } as Response;
    }),
  );
  vi.mocked(getAuthToken).mockImplementation(async () => `fixture-${clerk.user?.id}`);
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:upload-test");
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("selection and recording upload lifetimes", () => {
  it("keeps later batch files cancelled even if a caller swallows the first failure", async () => {
    const scope = createAssetUploadLifetime();
    const files = [new File(["A image"], "a.png", { type: "image/png" }), requestInput().file];
    const result = (async () => {
      try {
        for (const file of files) {
          await uploadAccountAsset({ file, source: "paste", signal: scope.signal }).catch(
            () => undefined,
          );
        }
      } finally {
        scope.dispose();
      }
    })();
    switchAccount("account-B");
    images[0]!.onload?.();
    await result;
    expect(calls).toEqual([]);
    expect(puts).toEqual([]);
    expect(listeners.size).toBe(0);
  });

  it.each([false, true])(
    "binds delayed recording intent before upload begins (return to A: %s)",
    async (returnToA) => {
      const scope = createAssetUploadLifetime();
      const recording = deferred<File>();
      const result = observe(
        (async () => {
          try {
            const file = await recording.promise;
            scope.assertCurrent();
            return await uploadAccountAsset({ file, source: "recording", signal: scope.signal });
          } finally {
            scope.dispose();
          }
        })(),
      );
      switchAccount("account-B");
      if (returnToA) switchAccount("account-A");
      recording.resolve(new File(["recorded A bytes"], "recording.webm", { type: "video/webm" }));
      expect(await result).toMatchObject({ error: { name: "AbortError" } });
      expect(calls).toEqual([]);
      expect(puts).toEqual([]);
      expect(listeners.size).toBe(0);
    },
  );

  it("keeps an unchanged-account batch active until its owner disposes it", async () => {
    const scope = createAssetUploadLifetime();
    for (let index = 0; index < 2; index++) {
      const result = uploadAccountAsset({ ...requestInput(), signal: scope.signal });
      await vi.waitFor(() => expect(puts).toHaveLength(index + 1));
      puts[index]!.complete();
      await result;
      expect(scope.isCurrent()).toBe(true);
    }
    scope.dispose();
    expect(scope.signal.aborted).toBe(true);
    expect(scope.isCurrent()).toBe(false);
    expect(listeners.size).toBe(0);
  });
});

describe("shared asset upload account lifetime through real authFetch", () => {
  it("rejects a pre-cancelled operation without preparing or reserving", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(uploadAccountAsset(requestInput(controller.signal))).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(getAuthToken).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
    expect(listeners.size).toBe(0);
  });

  it("does not reserve A's image as B after asynchronous preparation", async () => {
    const result = observe(
      uploadAccountAsset({
        file: new File(["A image"], "a.png", { type: "image/png" }),
        source: "paste",
      }),
    );
    expect(images).toHaveLength(1);
    switchAccount("account-B");
    images[0]!.onload?.();
    expect(await result).toMatchObject({ error: { name: "AbortError" } });
    expect(calls).toEqual([]);
    expect(puts).toEqual([]);
  });

  it("permanently cancels on A to B to A, even without a caller signal", async () => {
    const result = observe(
      uploadAccountAsset({
        file: new File(["A image"], "a.png", { type: "image/png" }),
        source: "drop",
      }),
    );
    switchAccount("account-B");
    switchAccount("account-A");
    images[0]!.onload?.();
    expect(await result).toMatchObject({ error: { name: "AbortError" } });
    expect(calls).toEqual([]);
  });

  it("checks the SDK snapshot after token acquisition before listener delivery", async () => {
    const token = deferred<string>();
    vi.mocked(getAuthToken).mockReturnValueOnce(token.promise);
    const result = observe(uploadAccountAsset(requestInput()));
    await vi.waitFor(() => expect(getAuthToken).toHaveBeenCalledOnce());
    switchAccount("account-B", false);
    token.resolve("fixture-account-B");
    expect(await result).toMatchObject({ error: { name: "AbortError" } });
    expect(calls).toEqual([]);
  });

  it("does not upload or compensate as B when reservation JSON arrives late", async () => {
    const body = deferred<ReturnType<typeof reservation>>();
    vi.mocked(fetch).mockResolvedValueOnce({ ok: true, json: () => body.promise } as Response);
    const result = observe(uploadAccountAsset(requestInput()));
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    switchAccount("account-B");
    body.resolve(reservation());
    expect(await result).toMatchObject({ error: { name: "AbortError" } });
    expect(fetch).toHaveBeenCalledOnce();
    expect(puts).toEqual([]);
  });

  it("rejects a pre-aborted PUT after token wait and cleans up as the original account", async () => {
    const token = deferred<string>();
    vi.mocked(getAuthToken)
      .mockResolvedValueOnce("fixture-account-A")
      .mockReturnValueOnce(token.promise)
      .mockResolvedValueOnce("fixture-account-A");
    const controller = new AbortController();
    const result = observe(uploadAccountAsset(requestInput(controller.signal)));
    await vi.waitFor(() => expect(getAuthToken).toHaveBeenCalledTimes(2));
    controller.abort();
    expect(await result).toMatchObject({ error: { name: "AbortError" } });
    token.resolve("late-token");
    expect(puts).toEqual([]);
    expect(calls.map((call) => [call.init.method, call.account])).toEqual([
      ["POST", "account-A"],
      ["DELETE", "account-A"],
    ]);
    expect(calls[1]!.init.signal?.aborted).toBe(false);
  });

  it("aborts an in-flight upload on account change without using new-account cleanup", async () => {
    const result = observe(uploadAccountAsset(requestInput()));
    await vi.waitFor(() => expect(puts).toHaveLength(1));
    switchAccount("account-B");
    expect(await result).toMatchObject({ error: { name: "AbortError" } });
    expect(puts[0]!.aborted).toBe(true);
    expect(calls).toHaveLength(1);
    expect(listeners.size).toBe(0);
  });

  it("cancels user-requested uploads and sends cleanup with an independent signal", async () => {
    const controller = new AbortController();
    const result = observe(uploadAccountAsset(requestInput(controller.signal)));
    await vi.waitFor(() => expect(puts).toHaveLength(1));
    controller.abort();
    expect(await result).toMatchObject({ error: { name: "AbortError" } });
    expect(calls[1]!.url).toBe("/api/assets/901/reservation");
    expect(calls[1]!.init.signal).not.toBe(controller.signal);
    expect(calls[1]!.init.signal?.aborted).toBe(false);
  });

  it("guards compensation across its own token wait", async () => {
    const cleanupToken = deferred<string>();
    vi.mocked(getAuthToken)
      .mockResolvedValueOnce("fixture-account-A")
      .mockResolvedValueOnce("fixture-account-A")
      .mockReturnValueOnce(cleanupToken.promise);
    const result = observe(uploadAccountAsset(requestInput()));
    await vi.waitFor(() => expect(puts).toHaveLength(1));
    puts[0]!.complete(409, { error: "Upload rejected by server" });
    await vi.waitFor(() => expect(getAuthToken).toHaveBeenCalledTimes(3));
    switchAccount("account-B", false);
    cleanupToken.resolve("fixture-account-B");
    expect(await result).toMatchObject({ error: { message: "Upload rejected by server" } });
    expect(calls).toHaveLength(1);
  });

  it("keeps normal project uploads, progress, body, result and bearer authentication", async () => {
    const input = requestInput();
    const onProgress = vi.fn();
    const result = uploadProjectAsset({ ...input, projectId: 60, onProgress });
    await vi.waitFor(() => expect(puts).toHaveLength(1));
    const request = puts[0]!;
    request.upload.onprogress?.({ lengthComputable: true, loaded: 1, total: 2 });
    request.complete();
    expect(await result).toEqual({
      assetId: 901,
      name: "note.txt",
      mimeType: "text/plain",
      sizeBytes: input.file.size,
      contentUrl: "/api/assets/901/content",
      resized: false,
    });
    expect(calls[0]!.url).toBe("/api/projects/60/assets/reserve");
    expect(request.headers.get("authorization")).toBe("Bearer fixture-account-A");
    expect(request.withCredentials).toBe(true);
    expect(request.body).toBe(input.file);
    expect(onProgress).toHaveBeenCalledExactlyOnceWith(50);
    expect(request.upload.onprogress).toBeNull();
    expect(request.onload).toBeNull();
    expect(listeners.size).toBe(0);
  });

  it("preserves cookie-only uploads for an unchanged Clerk principal", async () => {
    vi.mocked(getAuthToken).mockResolvedValue(null);
    const result = uploadAccountAsset(requestInput());
    await vi.waitFor(() => expect(puts).toHaveLength(1));
    puts[0]!.complete();
    await result;
    expect(puts[0]!.headers.has("authorization")).toBe(false);
    expect(puts[0]!.withCredentials).toBe(true);
    expect(calls[0]!.init.credentials).toBe("include");
  });

  it("uses the cookie fallback when the PUT token refresh stalls", async () => {
    vi.useFakeTimers();
    vi.mocked(getAuthToken)
      .mockResolvedValueOnce("fixture-account-A")
      .mockReturnValueOnce(new Promise(() => undefined));
    const result = uploadAccountAsset(requestInput());
    await vi.advanceTimersByTimeAsync(3_000);
    expect(puts).toHaveLength(1);
    expect(puts[0]!.headers.has("authorization")).toBe(false);
    expect(puts[0]!.withCredentials).toBe(true);
    puts[0]!.complete();
    await expect(result).resolves.toMatchObject({ assetId: 901 });
  });

  it("rejects credential forwarding to a noncanonical upload destination", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ assetId: 901, uploadUrl: "https://outside.example/upload" }),
    } as Response);
    await expect(uploadAccountAsset(requestInput())).rejects.toThrow(
      "destination could not be verified",
    );
    expect(puts).toEqual([]);
    expect(calls[0]!.url).toBe("/api/assets/901/reservation");
  });

  it("retains explicit development E2E cookie mode", async () => {
    vi.stubGlobal("Clerk", undefined);
    vi.stubGlobal("__E2E_TEST_USER__", "test-account");
    vi.stubEnv("DEV", true);
    vi.mocked(getAuthToken).mockResolvedValue(null);
    const result = uploadAccountAsset(requestInput());
    await vi.waitFor(() => expect(puts).toHaveLength(1));
    puts[0]!.complete();
    await expect(result).resolves.toMatchObject({ assetId: 901 });
  });

  it("does not accept the E2E marker as a production principal", async () => {
    vi.stubGlobal("Clerk", undefined);
    vi.stubGlobal("__E2E_TEST_USER__", "test-account");
    vi.stubEnv("DEV", false);
    await expect(uploadAccountAsset(requestInput())).rejects.toMatchObject({ name: "AbortError" });
    expect(calls).toEqual([]);
  });
});
