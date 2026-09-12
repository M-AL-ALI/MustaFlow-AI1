import { useEffect, useRef } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider, useMutation, useQuery } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CodeEditorTab } from "./code-editor-tab";

type TestFile = { id: number; path: string; content: string; updatedAt: string };
type FileRequest = { id: number; fileId: number };
type SaveRequest = FileRequest & { data: { content: string } };
type DiagnosticsResult = {
  ok: boolean;
  tool: string;
  diagnostics: Array<{ line: number; column: number; severity: "error"; message: string }>;
};

const api = vi.hoisted(() => ({
  list: vi.fn(),
  file: vi.fn(),
  diagnose: vi.fn(),
  save: vi.fn(),
  unused: vi.fn(),
  toast: vi.fn(),
}));

const monaco = vi.hoisted(() => {
  const disposable = () => ({ dispose: vi.fn() });
  const model = { getLineCount: () => 20, getLineMaxColumn: () => 80 };
  const setModelMarkers = vi.fn();
  return {
    setModelMarkers,
    editor: {
      getModel: () => model,
      addCommand: vi.fn(),
      onDidChangeCursorSelection: vi.fn(disposable),
    },
    api: {
      MarkerSeverity: { Error: 8, Warning: 4, Info: 2 },
      editor: { setModelMarkers },
      languages: {
        registerCodeActionProvider: vi.fn(disposable),
        registerInlineCompletionsProvider: vi.fn(disposable),
      },
    },
  };
});

vi.mock("@monaco-editor/react", () => ({
  default: function MockEditor({
    value,
    onChange,
    onMount,
  }: {
    value: string;
    onChange(value: string): void;
    onMount(editor: typeof monaco.editor, api: typeof monaco.api): void | (() => void);
  }) {
    const mount = useRef(onMount);
    useEffect(() => mount.current(monaco.editor, monaco.api), []);
    return (
      <textarea
        aria-label="Code editor"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    );
  },
}));

vi.mock("@/lib/api-fetch", () => ({ authFetch: api.unused }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: api.toast }) }));
vi.mock("./debugger-panel", () => ({ DebuggerPanel: () => null }));
vi.mock("@/lib/snippets", () => ({ SNIPPETS: [], SNIPPET_CATEGORIES: [] }));

vi.mock("@workspace/api-client-react", () => ({
  getListProjectFilesQueryKey: (id: number) => [`/api/projects/${id}/files`],
  getGetProjectFileQueryKey: (id: number, fileId: number) => [
    `/api/projects/${id}/files/${fileId}`,
  ],
  getGetCheckRunsQueryKey: (id: number) => ["checks", id],
  useListProjectFiles: (id: number) =>
    useQuery({
      queryKey: [`/api/projects/${id}/files`],
      queryFn: () => api.list(id) as Promise<TestFile[]>,
    }),
  useGetProjectFile: (id: number, fileId: number, options?: { query?: { enabled?: boolean } }) =>
    useQuery({
      queryKey: [`/api/projects/${id}/files/${fileId}`],
      queryFn: () => api.file(id, fileId) as Promise<TestFile>,
      enabled: options?.query?.enabled,
    }),
  // Keep the real observer, pending/completion notifications and fresh result
  // object. A fixed mocked hook result would hide the dependency feedback loop.
  useGetProjectFileDiagnostics: () =>
    useMutation({
      mutationKey: ["getProjectFileDiagnostics"],
      mutationFn: (variables: FileRequest) => api.diagnose(variables) as Promise<DiagnosticsResult>,
    }),
  useUpdateProjectFile: () =>
    useMutation({
      mutationFn: (variables: SaveRequest) => api.save(variables) as Promise<TestFile>,
    }),
  useGetCheckRuns: () => ({ data: [] }),
  useCreateProjectFile: () => ({ mutateAsync: api.unused, isPending: false }),
  useDeleteProjectFile: () => ({ mutateAsync: api.unused, isPending: false }),
  useRenameProjectFile: () => ({ mutateAsync: api.unused, isPending: false }),
  useInstallPackage: () => ({ mutate: api.unused, isPending: false }),
  useUninstallPackage: () => ({ mutate: api.unused, isPending: false }),
}));

const PROJECT_ID = 61;
const MAIN_ID = 1004;
const OTHER_ID = 1005;
const INITIAL_REVISION = "2026-09-12T17:00:00.000Z";
const SAVED_REVISION = "2026-09-12T17:00:01.000Z";
const fileKey = (fileId: number) => [`/api/projects/${PROJECT_ID}/files/${fileId}`];
let queryClient: QueryClient;
let files: Map<number, TestFile>;

function diagnostics(message: string): DiagnosticsResult {
  return {
    ok: true,
    tool: "tsc",
    diagnostics: [{ line: 1, column: 1, severity: "error", message }],
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, resolve, reject };
}

async function advance(milliseconds: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(milliseconds);
  });
}

async function flushUpdates() {
  for (let i = 0; i < 4; i += 1) await advance(1);
}

async function idle(milliseconds: number) {
  // Flush React between timer steps so a render-triggered timer cannot hide
  // behind one large act() batch covering the whole idle interval.
  for (let elapsed = 0; elapsed < milliseconds; elapsed += 1000) {
    await advance(Math.min(1000, milliseconds - elapsed));
  }
}

function renderEditor() {
  return render(
    <QueryClientProvider client={queryClient}>
      <CodeEditorTab
        projectId={PROJECT_ID}
        initialFileId={MAIN_ID}
        containerLayerConfigured={true}
      />
    </QueryClientProvider>,
  );
}

function observedDiagnosticMessages(): string[] {
  return monaco.setModelMarkers.mock.calls
    .filter(([, owner]) => owner === "mustaflow-tsc")
    .flatMap(([, , markers]) =>
      (markers as Array<{ message: string }>).map((marker) => marker.message),
    );
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  localStorage.clear();
  files = new Map([
    [
      MAIN_ID,
      { id: MAIN_ID, path: "main.tsx", content: "export {};", updatedAt: INITIAL_REVISION },
    ],
    [
      OTHER_ID,
      { id: OTHER_ID, path: "helper.ts", content: "export {};", updatedAt: INITIAL_REVISION },
    ],
  ]);
  queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Infinity, gcTime: Infinity },
      mutations: { retry: false, gcTime: Infinity },
    },
  });
  queryClient.setQueryData([`/api/projects/${PROJECT_ID}/files`], [...files.values()]);
  for (const file of files.values()) queryClient.setQueryData(fileKey(file.id), file);
  api.list.mockReset().mockImplementation(async () => [...files.values()]);
  api.file.mockReset().mockImplementation(async (_id: number, fileId: number) => files.get(fileId));
  api.diagnose.mockReset().mockResolvedValue(diagnostics("current diagnostic"));
  api.save.mockReset().mockImplementation(async ({ fileId, data }: SaveRequest) => {
    const file = files.get(fileId);
    if (!file) throw new Error("Unknown test file");
    const saved = { ...file, content: data.content, updatedAt: SAVED_REVISION };
    files.set(fileId, saved);
    return saved;
  });
});

afterEach(() => {
  cleanup();
  queryClient.clear();
  vi.useRealTimers();
});

describe("CodeEditorTab diagnostics stability", () => {
  it.each(["success", "unavailable", "error"] as const)(
    "does not repeat an unchanged file during pending or 70 seconds after %s",
    async (outcome) => {
      const pending = deferred<DiagnosticsResult>();
      api.diagnose.mockReturnValueOnce(pending.promise);
      renderEditor();
      await advance(599);
      expect(api.diagnose).not.toHaveBeenCalled();
      await advance(1);
      await flushUpdates();
      expect(api.diagnose).toHaveBeenCalledExactlyOnceWith({ id: PROJECT_ID, fileId: MAIN_ID });
      expect(queryClient.getMutationCache().getAll()[0]?.state.status).toBe("pending");
      await idle(2000);
      expect(api.diagnose).toHaveBeenCalledTimes(1);

      await act(async () => {
        if (outcome === "error") pending.reject(new Error("Diagnostics unavailable"));
        else pending.resolve({ ...diagnostics("initial diagnostic"), ok: outcome === "success" });
        await pending.promise.catch(() => undefined);
      });
      await flushUpdates();
      expect(queryClient.getMutationCache().getAll()[0]?.state.status).toBe(
        outcome === "error" ? "error" : "success",
      );
      if (outcome === "success") {
        expect(observedDiagnosticMessages()).toContain("initial diagnostic");
      } else {
        expect(observedDiagnosticMessages()).toEqual([]);
      }
      await idle(70_000);
      expect(api.diagnose).toHaveBeenCalledTimes(1);
      expect(api.save).not.toHaveBeenCalled();
      expect(api.unused).not.toHaveBeenCalled();
    },
  );

  it("runs once for a new file and once for a saved revision, without delaying immediate sync", async () => {
    renderEditor();
    await advance(600);
    await flushUpdates();
    expect(api.diagnose).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByText("helper.ts"));
    await advance(599);
    expect(api.diagnose).toHaveBeenCalledTimes(1);
    await advance(1);
    await flushUpdates();
    expect(api.diagnose).toHaveBeenNthCalledWith(2, { id: PROJECT_ID, fileId: OTHER_ID });

    fireEvent.change(screen.getByRole("textbox", { name: "Code editor" }), {
      target: { value: "export const saved = true;" },
    });
    await idle(2000);
    expect(api.diagnose).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await flushUpdates();
    expect(api.save).toHaveBeenCalledExactlyOnceWith({
      id: PROJECT_ID,
      fileId: OTHER_ID,
      data: { content: "export const saved = true;" },
    });
    expect(queryClient.getQueryData<TestFile>(fileKey(OTHER_ID))?.updatedAt).toBe(SAVED_REVISION);
    expect(api.diagnose).toHaveBeenNthCalledWith(3, { id: PROJECT_ID, fileId: OTHER_ID });
    await idle(70_000);
    expect(api.diagnose).toHaveBeenCalledTimes(3);
  });

  it("does not apply a stale file response after the new file completes", async () => {
    const stale = deferred<DiagnosticsResult>();
    api.diagnose
      .mockReturnValueOnce(stale.promise)
      .mockResolvedValueOnce(diagnostics("new file diagnostic"));
    renderEditor();
    await advance(600);
    await flushUpdates();
    fireEvent.click(screen.getByText("helper.ts"));
    await advance(600);
    await flushUpdates();
    expect(observedDiagnosticMessages()).toContain("new file diagnostic");

    await act(async () => {
      stale.resolve(diagnostics("stale file diagnostic"));
      await stale.promise;
    });
    await flushUpdates();
    expect(observedDiagnosticMessages()).not.toContain("stale file diagnostic");
    await idle(2000);
    expect(api.diagnose).toHaveBeenCalledTimes(2);
  });

  it("cancels a pending debounce when the Code tool unmounts", async () => {
    const view = renderEditor();
    await advance(599);
    view.unmount();
    await idle(70_000);
    expect(api.diagnose).not.toHaveBeenCalled();
  });
});
