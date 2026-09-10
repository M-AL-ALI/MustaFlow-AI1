import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import type { PropsWithChildren } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AssetUploadResult } from "./asset-upload";

const fixture = vi.hoisted(() => ({
  signedIn: true,
  token: vi.fn<() => Promise<string | null>>(),
  toast: vi.fn(),
  queryClient: { invalidateQueries: vi.fn() },
}));
vi.mock("@workspace/api-client-react", () => ({
  getAuthToken: fixture.token,
  useListMessages: () => ({ data: [] }),
  useListTasks: () => ({ data: [] }),
  useListVersions: () => ({ data: [] }),
  useListTaskEvents: () => ({ data: [] }),
  useSendMessage: () => ({ isPending: false, mutate: vi.fn() }),
  useRollbackVersion: () => ({ isPending: false, mutate: vi.fn() }),
  useListKnowledge: () => ({ data: [], isLoading: false, refetch: vi.fn() }),
  getListKnowledgeQueryKey: () => ["knowledge"],
  getListMessagesQueryKey: () => ["messages"],
  getListTasksQueryKey: () => ["tasks"],
  getListVersionsQueryKey: () => ["versions"],
  getListProjectFilesQueryKey: () => ["files"],
  getGetProjectQueryKey: () => ["project"],
  getListTaskEventsQueryKey: () => ["events"],
}));
vi.mock("@tanstack/react-query", () => ({ useQueryClient: () => fixture.queryClient }));
vi.mock("@clerk/react", () => ({
  useUser: () => ({ isLoaded: true, isSignedIn: fixture.signedIn }),
}));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: fixture.toast }) }));
vi.mock("@/hooks/ora-conversations-context", () => ({
  useOraConversationsOptional: () => null,
}));
vi.mock("@/components/layout/app-layout", () => ({
  AppLayout: ({ children }: PropsWithChildren) => <>{children}</>,
}));
vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: PropsWithChildren) => <>{children}</>,
  TooltipContent: () => null,
  TooltipTrigger: ({ children }: PropsWithChildren) => <>{children}</>,
}));
vi.mock("@/components/agent-thinking-bubble", () => ({ AgentThinkingBubble: () => null }));
vi.mock("@/components/icons/dynamic-atom", () => ({ DynamicAtom: () => null }));
vi.mock("@/pages/projects/components/chat-history", () => ({ MarkdownMessage: () => null }));
vi.mock("@/pages/projects/components/tool-call-card", () => ({ ToolCallGroup: () => null }));
vi.mock("@/pages/projects/components/plan-card", () => ({ PlanCard: () => null }));
vi.mock("@/pages/projects/components/zero-prompt-queue-drawer", () => ({
  ZeroPromptQueueDrawer: () => null,
}));
vi.mock("@/lib/builder-followup-submit", () => ({
  useBuilderCreditCosts: () => ({ standard: { lite: 1, eco: 2, power: 3, pro: 4 } }),
}));
vi.mock("./asset-upload", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./asset-upload")>();
  return {
    ...actual,
    createAssetUploadLifetime: vi.fn(actual.createAssetUploadLifetime),
    uploadProjectAsset: vi.fn(),
    uploadAccountAsset: vi.fn(),
  };
});

import { createAssetUploadLifetime, uploadAccountAsset, uploadProjectAsset } from "./asset-upload";
import { DevChatPanel } from "@/pages/dev-workspace/components/dev-chat-panel";
import { ZeroAgentPanel } from "@/pages/projects/components/zero-agent-panel";
import MemoryPage from "@/pages/memory";
import { useOraChat } from "@/hooks/use-ora-chat";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

const result: AssetUploadResult = {
  assetId: 901,
  name: "first.png",
  mimeType: "image/png",
  sizeBytes: 5,
  contentUrl: "/api/assets/901/content",
  resized: false,
};
const attachment = {
  filename: "first.png",
  fileType: "image",
  imageRef: "image-901",
  analysisStatus: "ready",
  imageCount: 1,
  imageLimit: 10,
};
const listeners = new Set<(resources: { user: { id: string } | null }) => void>();
let clerk: {
  loaded: boolean;
  user: { id: string } | null;
  addListener: (listener: (resources: { user: { id: string } | null }) => void) => () => void;
};
function switchAccount(backToA = false) {
  clerk.user = { id: "B" };
  for (const listener of [...listeners]) listener({ user: clerk.user });
  if (backToA) {
    clerk.user = { id: "A" };
    for (const listener of [...listeners]) listener({ user: clerk.user });
  }
}
const file = (name = "first.png") => new File(["bytes"], name, { type: "image/png" });
let responseGate: Promise<Response> | undefined;
let attachmentBody: Record<string, unknown>;
const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = String(input);
  const mutation = init?.method === "PATCH" || url.endsWith("/upload/attach");
  if (mutation && responseGate) return responseGate;
  if (url.endsWith("/upload/attach") || url.endsWith("/public-ai/upload")) {
    return new Response(JSON.stringify(attachmentBody));
  }
  return new Response(
    JSON.stringify({
      profile: null,
      memories: [],
      entries: [],
      items: [],
      messages: [],
      sessionId: "session",
      msgCount: 0,
      msgLimit: 10,
      fileCount: 0,
      fileLimit: 10,
      imageCount: 0,
      imageLimit: 10,
      usedBytes: 0,
      reservedBytes: 0,
      limitBytes: 10000,
    }),
  );
});
const mutations = () =>
  fetchMock.mock.calls.filter(
    ([input, init]) => init?.method === "PATCH" || String(input).endsWith("/upload/attach"),
  );
let originalScrollTo: PropertyDescriptor | undefined;
let originalMediaDevices: PropertyDescriptor | undefined;
beforeEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  listeners.clear();
  localStorage.clear();
  sessionStorage.clear();
  responseGate = undefined;
  attachmentBody = { ...attachment };
  fixture.signedIn = true;
  fixture.token.mockReset().mockResolvedValue(null);
  vi.mocked(uploadProjectAsset).mockReset().mockResolvedValue(result);
  vi.mocked(uploadAccountAsset).mockReset().mockResolvedValue(result);
  clerk = {
    loaded: true,
    user: { id: "A" },
    addListener(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  vi.stubGlobal("Clerk", clerk);
  vi.stubGlobal("__E2E_TEST_USER__", undefined);
  vi.stubGlobal("fetch", fetchMock);
  let nextUrl = 0;
  vi.spyOn(URL, "createObjectURL").mockImplementation(() => `blob:selection-${++nextUrl}`);
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  originalMediaDevices = Object.getOwnPropertyDescriptor(navigator, "mediaDevices");
  originalScrollTo = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollTo");
  Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, value: vi.fn() });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  if (originalMediaDevices) Object.defineProperty(navigator, "mediaDevices", originalMediaDevices);
  else Reflect.deleteProperty(navigator, "mediaDevices");
  if (originalScrollTo) Object.defineProperty(HTMLElement.prototype, "scrollTo", originalScrollTo);
  else Reflect.deleteProperty(HTMLElement.prototype, "scrollTo");
});

function mountBatch(surface: "developer" | "zero") {
  return render(
    surface === "developer" ? (
      <DevChatPanel projectId={60} />
    ) : (
      <ZeroAgentPanel projectId={60} isOpen onClose={() => {}} />
    ),
  );
}
function selectFiles(container: HTMLElement, files: File[]) {
  const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
  fireEvent.change(input, { target: { files } });
}

describe.each(["developer", "zero"] as const)("%s real selection loop", (surface) => {
  it.each([false, true])("retires the remaining batch, return to A=%s", async (backToA) => {
    const first = deferred<AssetUploadResult>();
    vi.mocked(uploadProjectAsset).mockReturnValueOnce(first.promise);
    const view = mountBatch(surface);
    selectFiles(view.container, [file(), file("second.png")]);
    expect(uploadProjectAsset).toHaveBeenCalledTimes(1);
    const signal = vi.mocked(uploadProjectAsset).mock.calls[0]![0].signal!;
    await act(async () => {
      switchAccount(backToA);
      first.resolve(result); // Deliberately ignores the aborted signal.
    });
    expect(signal.aborted).toBe(true);
    expect(uploadProjectAsset).toHaveBeenCalledTimes(1);
    expect(createAssetUploadLifetime).toHaveBeenCalledTimes(1);
    if (surface === "developer") expect(URL.revokeObjectURL).toHaveBeenCalledTimes(2);
    expect(listeners.size).toBe(0);
  });

  it("completes an unchanged-account batch using one selection lifetime", async () => {
    const first = deferred<AssetUploadResult>();
    vi.mocked(uploadProjectAsset).mockReturnValueOnce(first.promise);
    const view = mountBatch(surface);
    selectFiles(view.container, [file(), file("second.png")]);
    await act(async () => {
      first.resolve(result);
    });
    await waitFor(() => expect(uploadProjectAsset).toHaveBeenCalledTimes(2));
    expect(createAssetUploadLifetime).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(listeners.size).toBe(0));
  });
});

it("keeps the developer image cap at four", async () => {
  const view = mountBatch("developer");
  await act(async () =>
    selectFiles(
      view.container,
      Array.from({ length: 5 }, (_, i) => file(`${i}.png`)),
    ),
  );
  expect(uploadProjectAsset).toHaveBeenCalledTimes(4);
});

it("cancels one Zero file after progress without cancelling the next file", async () => {
  vi.mocked(uploadProjectAsset).mockImplementationOnce(
    (input) =>
      new Promise((_, reject) => {
        input.signal!.addEventListener(
          "abort",
          () => reject(new DOMException("Upload cancelled", "AbortError")),
          { once: true },
        );
      }),
  );
  const view = mountBatch("zero");
  selectFiles(view.container, [file(), file("second.png")]);
  const first = vi.mocked(uploadProjectAsset).mock.calls[0]![0];
  act(() => first.onProgress?.(42));
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "\u00d7" }));
  });
  expect(first.signal!.aborted).toBe(true);
  expect(uploadProjectAsset).toHaveBeenCalledTimes(2);
  expect(createAssetUploadLifetime).toHaveBeenCalledTimes(1);
});

class Recorder {
  static instances: Recorder[] = [];
  state = "inactive";
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  stop = vi.fn(() => {
    this.state = "inactive";
    this.ondataavailable?.({ data: new Blob(["video"], { type: "video/webm" }) });
    this.onstop?.();
  });
  constructor() {
    Recorder.instances.push(this);
  }
  start() {
    this.state = "recording";
  }
}
function mediaFixtures() {
  const stop = vi.fn();
  const stream = { getTracks: () => [{ stop }] } as unknown as MediaStream;
  const media = deferred<MediaStream>();
  Recorder.instances = [];
  vi.stubGlobal("MediaRecorder", Recorder);
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { getDisplayMedia: vi.fn(() => media.promise) },
  });
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    drawImage: vi.fn(),
  } as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation((done) =>
    done(new Blob(["frame"], { type: "image/png" })),
  );
  return { media, stream, stop };
}
describe("real preview recording continuation", () => {
  it.each([false, true])(
    "stops media granted after cancellation, return to A=%s",
    async (backToA) => {
      const { media, stream, stop } = mediaFixtures();
      mountBatch("zero");
      fireEvent.click(screen.getByRole("button", { name: "Record preview for eight seconds" }));
      expect(createAssetUploadLifetime).toHaveBeenCalledTimes(1);
      await act(async () => {
        switchAccount(backToA);
        media.resolve(stream);
      });
      expect(stop).toHaveBeenCalled();
      expect(uploadProjectAsset).not.toHaveBeenCalled();
      expect(Recorder.instances).toHaveLength(0);
    },
  );

  it.each([false, true])(
    "stops an active recorder during its timer, return to A=%s",
    async (backToA) => {
      vi.useFakeTimers();
      const { media, stream, stop } = mediaFixtures();
      mountBatch("zero");
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Record preview for eight seconds" }));
        media.resolve(stream);
      });
      expect(Recorder.instances).toHaveLength(1);
      const lateData = Recorder.instances[0]!.ondataavailable!;
      await act(async () => {
        switchAccount(backToA);
        lateData({ data: new Blob(["late"]) });
        await vi.advanceTimersByTimeAsync(8000);
      });
      expect(stop).toHaveBeenCalled();
      expect(Recorder.instances[0]!.stop).toHaveBeenCalled();
      expect(uploadProjectAsset).not.toHaveBeenCalled();
    },
  );

  it("uses the original lifetime for all three recording uploads", async () => {
    vi.useFakeTimers();
    const { media, stream, stop } = mediaFixtures();
    mountBatch("zero");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Record preview for eight seconds" }));
      media.resolve(stream);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(8000);
    });
    expect(uploadProjectAsset).toHaveBeenCalledTimes(3);
    expect(vi.mocked(uploadProjectAsset).mock.calls.map(([input]) => input.source)).toEqual([
      "recording",
      "recording",
      "recording",
    ]);
    expect(createAssetUploadLifetime).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalled();
    expect(listeners.size).toBe(0);
  });

  it("releases a late media grant after the component exits", async () => {
    const { media, stream, stop } = mediaFixtures();
    const view = mountBatch("zero");
    fireEvent.click(screen.getByRole("button", { name: "Record preview for eight seconds" }));
    view.unmount();
    await act(async () => {
      media.resolve(stream);
    });
    expect(stop).toHaveBeenCalled();
    expect(uploadProjectAsset).not.toHaveBeenCalled();
  });
});

async function mountContinuation(surface: "memory" | "ora") {
  if (surface === "memory") {
    const view = render(<MemoryPage />);
    await waitFor(() =>
      expect(view.container.querySelector<HTMLInputElement>('input[type="file"]')?.disabled).toBe(
        false,
      ),
    );
    const input = view.container.querySelector<HTMLInputElement>('input[type="file"]')!;
    return {
      start: () => {
        fireEvent.change(input, { target: { files: [file()] } });
      },
      attached: () => Boolean(view.container.querySelector('img[alt="Current brand logo"]')),
    };
  }
  const hook = renderHook(() => useOraChat());
  await waitFor(() => expect(hook.result.current.session).not.toBeNull());
  return {
    start: () => {
      void hook.result.current.uploadFile(file());
    },
    attached: () => hook.result.current.attachedFile !== null,
  };
}

describe.each(["memory", "ora"] as const)("%s real post-upload continuation", (surface) => {
  it.each([
    ["upload", false],
    ["upload", true],
    ["token", false],
    ["token", true],
    ["response", false],
    ["response", true],
  ] as const)("blocks obsolete %s completion, return to A=%s", async (boundary, backToA) => {
    const ui = await mountContinuation(surface);
    const upload = deferred<AssetUploadResult>();
    const token = deferred<string | null>();
    const response = deferred<Response>();
    fetchMock.mockClear();
    fixture.token.mockClear();
    if (boundary === "upload") vi.mocked(uploadAccountAsset).mockReturnValueOnce(upload.promise);
    if (boundary === "token") fixture.token.mockReturnValueOnce(token.promise);
    if (boundary === "response") responseGate = response.promise;
    act(() => ui.start());
    await waitFor(() => expect(uploadAccountAsset).toHaveBeenCalledTimes(1));
    if (boundary === "token") await waitFor(() => expect(fixture.token).toHaveBeenCalled());
    if (boundary === "response") await waitFor(() => expect(mutations()).toHaveLength(1));
    await act(async () => {
      switchAccount(backToA);
      upload.resolve(result);
      token.resolve("replacement-token");
      response.resolve(new Response(JSON.stringify(attachment)));
    });
    expect(mutations()).toHaveLength(boundary === "response" ? 1 : 0);
    expect(ui.attached()).toBe(false);
    expect(fixture.toast).not.toHaveBeenCalled();
    expect(listeners.size).toBe(0);
  });

  it("preserves the unchanged-account mutation and result", async () => {
    const ui = await mountContinuation(surface);
    fetchMock.mockClear();
    await act(async () => ui.start());
    await waitFor(() => expect(ui.attached()).toBe(true));
    expect(mutations()).toHaveLength(1);
    const [, init] = mutations()[0]!;
    expect(JSON.parse(String(init!.body))).toMatchObject(
      surface === "memory" ? { brandRole: "logo", altText: "Brand logo" } : { assetId: 901 },
    );
    expect(createAssetUploadLifetime).toHaveBeenCalledTimes(1);
    expect(listeners.size).toBe(0);
  });
});

it("preserves Ora analysis-unavailable handling", async () => {
  attachmentBody = {
    ...attachment,
    analysisStatus: "unavailable",
    analysisMessage: "Analysis unavailable",
  };
  const hook = renderHook(() => useOraChat());
  await waitFor(() => expect(hook.result.current.session).not.toBeNull());
  await act(async () => {
    await hook.result.current.uploadFile(file());
  });
  expect(hook.result.current.attachedFile).toBeNull();
  expect(hook.result.current.uploadState).toBe("error");
  expect(hook.result.current.uploadError).toBe("Analysis unavailable");
});

it("preserves anonymous Ora uploads without creating an authenticated lifetime", async () => {
  fixture.signedIn = false;
  const hook = renderHook(() => useOraChat());
  await waitFor(() => expect(hook.result.current.session).not.toBeNull());
  const document = new File(["guest document"], "guest.txt", { type: "text/plain" });
  attachmentBody = { filename: "guest.txt", fileType: "txt", fileRef: "guest-ref", charCount: 14 };
  await act(async () => {
    await hook.result.current.uploadFile(document);
  });
  expect(createAssetUploadLifetime).not.toHaveBeenCalled();
  expect(uploadAccountAsset).not.toHaveBeenCalled();
  expect(hook.result.current.attachedFile?.fileRef).toBe("guest-ref");
  expect(
    fetchMock.mock.calls.some(
      ([input, init]) =>
        String(input).endsWith("/public-ai/upload") && init?.body instanceof FormData,
    ),
  ).toBe(true);
});
