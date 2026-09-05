import { act, cleanup, renderHook } from "@testing-library/react";
import { StrictMode, useLayoutEffect, type PropsWithChildren } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectImageItem } from "./project-image-model";
import { useProjectImages } from "./use-project-images";

const { authFetchMock } = vi.hoisted(() => ({
  authFetchMock: vi.fn(),
}));

vi.mock("@/lib/api-fetch", () => ({
  authFetch: authFetchMock,
}));

type HookProps = Parameters<typeof useProjectImages>[0];
type HookValue = ReturnType<typeof useProjectImages>;

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

interface PendingRequest {
  url: string;
  init?: RequestInit;
  response: Deferred<Response>;
}

const PROJECT_A = 101;
const PROJECT_B = 202;
const GENERATE_OPTIONS = {
  quality: "standard",
  aspectRatio: "1:1",
  style: "natural",
} as const;
const IMAGE_BASE64 = "aW1hZ2U=";

let requests: PendingRequest[];
let fileReaders: ControlledFileReader[];

class ControlledFileReader {
  result: string | null = null;
  error: Error | null = null;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  blob: Blob | null = null;

  readAsDataURL(blob: Blob) {
    this.blob = blob;
    fileReaders.push(this);
  }

  complete() {
    this.result = "data:image/png;base64," + IMAGE_BASE64;
    this.onload?.();
  }
}

function deferred<T>(): Deferred<T> {
  let resolve!: Deferred<T>["resolve"];
  let reject!: Deferred<T>["reject"];
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function propsFor(projectId: number, overrides: Partial<HookProps> = {}): HookProps {
  return {
    projectId,
    enabled: false,
    taskIds: [],
    projectFiles: [],
    liveAssets: [],
    onThreadImage: vi.fn(),
    onProjectFileInserted: vi.fn(),
    ...overrides,
  };
}

function renderImages(props: HookProps) {
  return renderHook((current: HookProps) => useProjectImages(current), {
    initialProps: props,
  });
}

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn().mockResolvedValue(body),
    blob: vi.fn().mockResolvedValue(new Blob(["image"], { type: "image/png" })),
  } as unknown as Response;
}

function delayedJsonResponse(body: Deferred<unknown>): Response {
  const response = jsonResponse(undefined);
  response.json = vi.fn(() => body.promise);
  return response;
}

function studioRow(id: number, status: "pending" | "completed" = "completed") {
  return {
    id,
    prompt: "Image " + id,
    status,
    fileUrl: "/api/images/" + id + "/file",
    createdAt: "2026-09-04T00:00:00.000Z",
    ...GENERATE_OPTIONS,
  };
}

function completedImage(id = 501): ProjectImageItem {
  return {
    key: "studio:" + id,
    source: "studio",
    id,
    prompt: "Insert image " + id,
    status: "completed",
    imageUrl: "/api/images/" + id + "/file",
    createdAt: "2026-09-04T00:00:00.000Z",
    ...GENERATE_OPTIONS,
  };
}

function generationResponse(imageId: number): Response {
  return jsonResponse({
    jobId: "job-" + imageId,
    imageId,
    status: "pending",
  });
}

function matchingRequests(url: string) {
  return requests.filter((request) => request.url === url);
}

function requestAt(url: string, index = 0): PendingRequest {
  const request = matchingRequests(url)[index];
  expect(request, "Missing request " + index + " for " + url).toBeDefined();
  return request!;
}

function listUrl(projectId: number) {
  return "/api/images?projectId=" + projectId + "&limit=50";
}

function imageIds(value: HookValue) {
  return value.images.map((image) => image.id);
}

function settle<T>(promise: Promise<T>): Promise<PromiseSettledResult<T>> {
  return promise.then(
    (value) => ({ status: "fulfilled" as const, value }),
    (reason: unknown) => ({ status: "rejected" as const, reason }),
  );
}

async function resolveRequest(request: PendingRequest, response: Response) {
  await act(async () => {
    request.response.resolve(response);
    await request.response.promise;
  });
}

async function rejectRequest(request: PendingRequest, error: Error) {
  await act(async () => {
    request.response.reject(error);
  });
}

async function completeFileRead(index = 0) {
  expect(fileReaders[index], "Expected an image FileReader").toBeDefined();
  await act(async () => {
    fileReaders[index]!.complete();
  });
}

function expectProjectChanged(outcome: PromiseSettledResult<unknown>) {
  expect(outcome.status).toBe("rejected");
  if (outcome.status === "rejected") {
    expect(outcome.reason).toBeInstanceOf(Error);
    expect((outcome.reason as Error).message).toMatch(/Project changed/);
  }
}

function StrictWrapper({ children }: PropsWithChildren) {
  return <StrictMode>{children}</StrictMode>;
}

beforeEach(() => {
  vi.useFakeTimers();
  requests = [];
  fileReaders = [];
  authFetchMock.mockReset();
  authFetchMock.mockImplementation((url: string, init?: RequestInit) => {
    const response = deferred<Response>();
    requests.push({ url, init, response });
    return response.promise;
  });
  vi.stubGlobal("FileReader", ControlledFileReader);
});

afterEach(() => {
  cleanup();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("useProjectImages project isolation", () => {
  it("does not dispatch retained A generation, regeneration, or refresh callbacks after B mounts", async () => {
    const a = propsFor(PROJECT_A);
    const b = propsFor(PROJECT_B);
    const hook = renderImages(a);
    const retained = hook.result.current;
    hook.rerender(b);

    await act(async () => {
      await retained.generateImage("Old A prompt", GENERATE_OPTIONS);
      await retained.regenerateImage(completedImage());
      await retained.refresh();
    });

    expect(authFetchMock).not.toHaveBeenCalled();
    expect(hook.result.current.images).toEqual([]);
    expect(hook.result.current.error).toBeNull();
    expect(hook.result.current.isGenerating).toBe(false);
    expect(a.onThreadImage).not.toHaveBeenCalled();
    expect(b.onThreadImage).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "rejects retained A insertion before any request, including existing-path shortcut=%s",
    async (hasExistingPath) => {
      const a = propsFor(PROJECT_A);
      const b = propsFor(PROJECT_B);
      const hook = renderImages(a);
      const insert = hook.result.current.insertIntoProject;
      hook.rerender(b);
      const image = completedImage();
      if (hasExistingPath) image.path = "public/images/already-in-A.png";

      let outcome!: PromiseSettledResult<string>;
      await act(async () => {
        outcome = await settle(insert(image));
      });

      expectProjectChanged(outcome);
      expect(authFetchMock).not.toHaveBeenCalled();
      expect(a.onProjectFileInserted).not.toHaveBeenCalled();
      expect(b.onProjectFileInserted).not.toHaveBeenCalled();
    },
  );

  it("ignores an A list body that finishes parsing after B has loaded", async () => {
    const a = propsFor(PROJECT_A, { enabled: true });
    const b = propsFor(PROJECT_B, { enabled: true });
    const hook = renderImages(a);
    const oldBody = deferred<unknown>();
    await resolveRequest(requestAt(listUrl(PROJECT_A)), delayedJsonResponse(oldBody));

    hook.rerender(b);
    await resolveRequest(
      requestAt(listUrl(PROJECT_B)),
      jsonResponse({ images: [studioRow(2021)] }),
    );
    expect(imageIds(hook.result.current)).toEqual([2021]);

    await act(async () => {
      oldBody.resolve({ images: [studioRow(1011)] });
      await oldBody.promise;
    });

    expect(imageIds(hook.result.current)).toEqual([2021]);
    expect(hook.result.current.error).toBeNull();
    expect(hook.result.current.loading).toBe(false);
    expect(a.onThreadImage).not.toHaveBeenCalled();
    expect(b.onThreadImage).not.toHaveBeenCalled();
  });

  it("does not let an old A list rejection clear B loading or publish an error", async () => {
    const hook = renderImages(propsFor(PROJECT_A, { enabled: true }));
    const oldList = requestAt(listUrl(PROJECT_A));
    hook.rerender(propsFor(PROJECT_B, { enabled: true }));
    expect(hook.result.current.loading).toBe(true);

    await rejectRequest(oldList, new Error("A list failed"));

    expect(hook.result.current.loading).toBe(true);
    expect(hook.result.current.error).toBeNull();
    expect(hook.result.current.images).toEqual([]);
    await resolveRequest(
      requestAt(listUrl(PROJECT_B)),
      jsonResponse({ images: [studioRow(2022)] }),
    );
    expect(hook.result.current.loading).toBe(false);
    expect(imageIds(hook.result.current)).toEqual([2022]);
  });

  it.each([200, 403])(
    "ignores late A generation status %s without updating B state or either callback",
    async (status) => {
      const a = propsFor(PROJECT_A);
      const b = propsFor(PROJECT_B);
      const hook = renderImages(a);
      let operation!: Promise<PromiseSettledResult<void>>;
      act(() => {
        operation = settle(hook.result.current.generateImage("A only", GENERATE_OPTIONS));
      });
      const request = requestAt("/api/images/generate");
      expect(JSON.parse(String(request.init?.body))).toMatchObject({
        projectId: PROJECT_A,
      });
      hook.rerender(b);

      await resolveRequest(
        request,
        status === 200
          ? generationResponse(1012)
          : jsonResponse({ error: "A generation denied" }, status),
      );

      expect((await operation).status).toBe("fulfilled");
      expect(hook.result.current.images).toEqual([]);
      expect(hook.result.current.error).toBeNull();
      expect(hook.result.current.isGenerating).toBe(false);
      expect(a.onThreadImage).not.toHaveBeenCalled();
      expect(b.onThreadImage).not.toHaveBeenCalled();
    },
  );

  it("allows inline generation with listing disabled and rejects same-tick duplicate submission", async () => {
    const props = propsFor(PROJECT_A);
    const hook = renderImages(props);
    let first!: Promise<void>;
    let duplicate!: Promise<void>;
    act(() => {
      first = hook.result.current.generateImage("Inline image", GENERATE_OPTIONS);
      duplicate = hook.result.current.generateImage("Duplicate click", GENERATE_OPTIONS);
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe("/api/images/generate");
    expect(JSON.parse(String(requests[0]!.init?.body))).toMatchObject({
      projectId: PROJECT_A,
      prompt: "Inline image",
    });
    await resolveRequest(requests[0]!, generationResponse(1013));
    await first;
    await duplicate;

    expect(imageIds(hook.result.current)).toEqual([1013]);
    expect(props.onThreadImage).toHaveBeenCalledTimes(1);
    expect(props.onThreadImage).toHaveBeenCalledWith(
      expect.objectContaining({ id: 1013, prompt: "Inline image" }),
    );
    expect(matchingRequests(listUrl(PROJECT_A))).toHaveLength(0);
  });

  it("does not let an old A completion unlock a new A submission after A to B to A", async () => {
    const oldA = propsFor(PROJECT_A);
    const newA = propsFor(PROJECT_A);
    const b = propsFor(PROJECT_B);
    const hook = renderImages(oldA);
    let oldOperation!: Promise<void>;
    let newOperation!: Promise<void>;
    act(() => {
      oldOperation = hook.result.current.generateImage("First A visit", GENERATE_OPTIONS);
    });
    hook.rerender(b);
    hook.rerender(newA);
    act(() => {
      newOperation = hook.result.current.generateImage("Second A visit", GENERATE_OPTIONS);
    });
    expect(matchingRequests("/api/images/generate")).toHaveLength(2);

    await resolveRequest(requestAt("/api/images/generate", 0), generationResponse(1014));
    await oldOperation;
    await act(async () => {
      await hook.result.current.generateImage("Must remain locked", GENERATE_OPTIONS);
    });

    expect(matchingRequests("/api/images/generate")).toHaveLength(2);
    expect(hook.result.current.images).toEqual([]);
    expect(hook.result.current.isGenerating).toBe(true);
    expect(oldA.onThreadImage).not.toHaveBeenCalled();
    expect(b.onThreadImage).not.toHaveBeenCalled();
    expect(newA.onThreadImage).not.toHaveBeenCalled();

    await resolveRequest(requestAt("/api/images/generate", 1), generationResponse(1015));
    await newOperation;
    expect(imageIds(hook.result.current)).toEqual([1015]);
    expect(newA.onThreadImage).toHaveBeenCalledTimes(1);
  });

  it("keeps a Strict Mode replay submission locked when the discarded generation completes", async () => {
    const props = propsFor(PROJECT_A);
    const operations: Promise<PromiseSettledResult<void>>[] = [];
    const hook = renderHook(
      (current: HookProps) => {
        const images = useProjectImages(current);
        useLayoutEffect(() => {
          operations.push(settle(images.generateImage("Strict replay image", GENERATE_OPTIONS)));
        }, [images.generateImage]);
        return images;
      },
      { initialProps: props, wrapper: StrictWrapper, reactStrictMode: true },
    );

    expect(operations).toHaveLength(2);
    expect(matchingRequests("/api/images/generate")).toHaveLength(2);
    await resolveRequest(requestAt("/api/images/generate", 0), generationResponse(1016));
    expect((await operations[0]!).status).toBe("fulfilled");
    await act(async () => {
      await hook.result.current.generateImage("Still locked after replay", GENERATE_OPTIONS);
    });

    expect(matchingRequests("/api/images/generate")).toHaveLength(2);
    expect(hook.result.current.images).toEqual([]);
    expect(props.onThreadImage).not.toHaveBeenCalled();
    expect(hook.result.current.isGenerating).toBe(true);

    await resolveRequest(requestAt("/api/images/generate", 1), generationResponse(1017));
    expect((await operations[1]!).status).toBe("fulfilled");
    expect(imageIds(hook.result.current)).toEqual([1017]);
    expect(props.onThreadImage).toHaveBeenCalledTimes(1);

    let next!: Promise<void>;
    act(() => {
      next = hook.result.current.generateImage("New operation after release", GENERATE_OPTIONS);
    });
    expect(matchingRequests("/api/images/generate")).toHaveLength(3);
    await resolveRequest(requestAt("/api/images/generate", 2), generationResponse(1018));
    await next;
    expect(props.onThreadImage).toHaveBeenCalledTimes(2);
  });

  it("masks A images, errors, and loading state at B's first layout commit", async () => {
    const snapshots: {
      projectId: number;
      keys: string[];
      error: string | null;
      loading: boolean;
    }[] = [];
    const hook = renderHook(
      (props: HookProps) => {
        const value = useProjectImages(props);
        useLayoutEffect(() => {
          snapshots.push({
            projectId: props.projectId,
            keys: value.images.map((image) => image.key),
            error: value.error,
            loading: value.loading,
          });
        });
        return value;
      },
      { initialProps: propsFor(PROJECT_A, { enabled: true }) },
    );
    await resolveRequest(
      requestAt(listUrl(PROJECT_A)),
      jsonResponse({ images: [studioRow(1019)] }),
    );
    act(() => {
      void hook.result.current.refresh();
    });
    await rejectRequest(requestAt(listUrl(PROJECT_A), 1), new Error("A-only error"));
    expect(imageIds(hook.result.current)).toEqual([1019]);
    expect(hook.result.current.error).toBe("A-only error");
    expect(hook.result.current.loading).toBe(false);

    hook.rerender(propsFor(PROJECT_B, { enabled: true }));

    const bCommits = snapshots.filter((snapshot) => snapshot.projectId === PROJECT_B);
    expect(bCommits.length).toBeGreaterThan(0);
    for (const snapshot of bCommits) {
      expect(snapshot.keys).toEqual([]);
      expect(snapshot.error).toBeNull();
      expect(snapshot.loading).toBe(true);
    }
    await resolveRequest(
      requestAt(listUrl(PROJECT_B)),
      jsonResponse({ images: [studioRow(2023)] }),
    );
    expect(imageIds(hook.result.current)).toEqual([2023]);
  });

  it.each(["response", "rejection"] as const)(
    "keeps the latest poll result when an older poll finishes with a %s",
    async (olderOutcome) => {
      const props = propsFor(PROJECT_A, { enabled: true });
      const hook = renderImages(props);
      await resolveRequest(
        requestAt(listUrl(PROJECT_A)),
        jsonResponse({ images: [studioRow(1020, "pending")] }),
      );
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2_000);
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2_000);
      });
      expect(matchingRequests(listUrl(PROJECT_A))).toHaveLength(3);
      await resolveRequest(
        requestAt(listUrl(PROJECT_A), 2),
        jsonResponse({ images: [studioRow(1022)] }),
      );
      expect(imageIds(hook.result.current)).toEqual([1022]);

      if (olderOutcome === "response") {
        await resolveRequest(
          requestAt(listUrl(PROJECT_A), 1),
          jsonResponse({ images: [studioRow(1021)] }),
        );
      } else {
        await rejectRequest(requestAt(listUrl(PROJECT_A), 1), new Error("Old poll failed"));
      }

      expect(imageIds(hook.result.current)).toEqual([1022]);
      expect(hook.result.current.error).toBeNull();
      expect(hook.result.current.isGenerating).toBe(false);
      expect(props.onThreadImage).not.toHaveBeenCalled();
    },
  );

  it("does not clear initial loading when a superseded list finishes first", async () => {
    const hook = renderImages(propsFor(PROJECT_A, { enabled: true }));
    act(() => {
      void hook.result.current.refresh();
    });
    await resolveRequest(
      requestAt(listUrl(PROJECT_A), 0),
      jsonResponse({ images: [studioRow(1023)] }),
    );
    expect(hook.result.current.loading).toBe(true);
    expect(hook.result.current.images).toEqual([]);

    await resolveRequest(
      requestAt(listUrl(PROJECT_A), 1),
      jsonResponse({ images: [studioRow(1024)] }),
    );
    expect(hook.result.current.loading).toBe(false);
    expect(imageIds(hook.result.current)).toEqual([1024]);
  });

  it("rejects insertion when A's file GET finishes after switching to B, without a file POST", async () => {
    const a = propsFor(PROJECT_A);
    const b = propsFor(PROJECT_B);
    const hook = renderImages(a);
    let operation!: Promise<PromiseSettledResult<string>>;
    act(() => {
      operation = settle(hook.result.current.insertIntoProject(completedImage()));
    });
    hook.rerender(b);
    await resolveRequest(requestAt("/api/images/501/file"), jsonResponse(undefined));

    expectProjectChanged(await operation);
    expect(requests).toHaveLength(1);
    expect(fileReaders).toHaveLength(0);
    expect(hook.result.current.images).toEqual([]);
    expect(a.onProjectFileInserted).not.toHaveBeenCalled();
    expect(b.onProjectFileInserted).not.toHaveBeenCalled();
  });

  it("rechecks the project after FileReader completion and before the file POST", async () => {
    const a = propsFor(PROJECT_A);
    const b = propsFor(PROJECT_B);
    const hook = renderImages(a);
    let operation!: Promise<PromiseSettledResult<string>>;
    act(() => {
      operation = settle(hook.result.current.insertIntoProject(completedImage()));
    });
    await resolveRequest(requestAt("/api/images/501/file"), jsonResponse(undefined));
    expect(fileReaders).toHaveLength(1);
    hook.rerender(b);
    await completeFileRead();

    expectProjectChanged(await operation);
    expect(requests).toHaveLength(1);
    expect(hook.result.current.images).toEqual([]);
    expect(a.onProjectFileInserted).not.toHaveBeenCalled();
    expect(b.onProjectFileInserted).not.toHaveBeenCalled();
  });

  it.each([201, 409])(
    "does not publish insertion callbacks or assets after A's already-dispatched POST returns %s in B",
    async (status) => {
      const a = propsFor(PROJECT_A);
      const b = propsFor(PROJECT_B);
      const hook = renderImages(a);
      let operation!: Promise<PromiseSettledResult<string>>;
      act(() => {
        operation = settle(hook.result.current.insertIntoProject(completedImage()));
      });
      await resolveRequest(requestAt("/api/images/501/file"), jsonResponse(undefined));
      await completeFileRead();
      const post = requestAt("/api/projects/" + PROJECT_A + "/files");
      expect(post.init?.method).toBe("POST");
      expect(JSON.parse(String(post.init?.body))).toMatchObject({
        content: IMAGE_BASE64,
      });
      hook.rerender(b);
      await resolveRequest(post, jsonResponse({}, status));

      expectProjectChanged(await operation);
      expect(requests).toHaveLength(2);
      expect(matchingRequests("/api/projects/" + PROJECT_B + "/files")).toHaveLength(0);
      expect(hook.result.current.images).toEqual([]);
      expect(a.onProjectFileInserted).not.toHaveBeenCalled();
      expect(b.onProjectFileInserted).not.toHaveBeenCalled();
      expect(a.onThreadImage).not.toHaveBeenCalled();
      expect(b.onThreadImage).not.toHaveBeenCalled();
    },
  );

  it("inserts and notifies normally when the originating project remains current", async () => {
    const props = propsFor(PROJECT_A);
    const hook = renderImages(props);
    let operation!: Promise<PromiseSettledResult<string>>;
    act(() => {
      operation = settle(hook.result.current.insertIntoProject(completedImage()));
    });
    await resolveRequest(requestAt("/api/images/501/file"), jsonResponse(undefined));
    await completeFileRead();
    const post = requestAt("/api/projects/" + PROJECT_A + "/files");
    const body = JSON.parse(String(post.init?.body)) as { path: string; content: string };
    expect(body).toEqual({
      path: expect.any(String),
      content: IMAGE_BASE64,
    });
    await resolveRequest(post, jsonResponse({}, 201));

    expect(await operation).toEqual({ status: "fulfilled", value: body.path });
    expect(hook.result.current.images).toContainEqual(
      expect.objectContaining({
        id: 501,
        source: "project",
        path: body.path,
        imageUrl: "/api/projects/" + PROJECT_A + "/preview/" + body.path,
      }),
    );
    expect(props.onProjectFileInserted).toHaveBeenCalledTimes(1);
    expect(props.onThreadImage).not.toHaveBeenCalled();
  });
});
