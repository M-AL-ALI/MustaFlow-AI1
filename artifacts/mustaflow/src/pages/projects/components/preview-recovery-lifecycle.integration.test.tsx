// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as React from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ts from "typescript";
import { getPreviewIframeSandbox, hasServerPreviewAccess } from "@/lib/preview-access-ui";
import {
  isPreviewAuthorizationStatus,
  isTerminalPreviewRecoveryError,
  presentPreviewRecovery,
  readPreviewRecoveryError,
  reconcilePreviewRecoveryError,
  type PreviewRecoveryError,
} from "./preview-recovery-presentation";

// Run the actual project lifecycle hooks and PreviewTab renderer together.
// The rest of the workspace and its providers are outside this scoped harness.
const directory = dirname(fileURLToPath(import.meta.url));
const workspaceSource = readFileSync(resolve(directory, "../[id].tsx"), "utf8");
const lifecycleStart = workspaceSource.indexOf("  type ContainerStatus =");
const lifecycleEnd = workspaceSource.indexOf("// \u2500\u2500 End container state", lifecycleStart);
if (lifecycleStart < 0 || lifecycleEnd <= lifecycleStart) {
  throw new Error("The project container lifecycle section was not found.");
}
const lifecycleSource = workspaceSource.slice(lifecycleStart, lifecycleEnd);
const previewSource = ts.createSourceFile(
  "preview-tab.tsx",
  readFileSync(resolve(directory, "./preview-tab.tsx"), "utf8"),
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
);
const previewComponent = previewSource.statements.find(
  (node): node is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(node) && node.name?.text === "PreviewTab",
);
if (!previewComponent?.body) throw new Error("PreviewTab was not found.");
const frameVariables = new Set([
  "previewAuthorizationStatus",
  "isAgentic",
  "serverPreviewLive",
  "agenticPreviewUnavailable",
  "basePreviewRecoveryPresentation",
  "runtimeActionLabel",
  "previewRecoveryPresentation",
  "previewRecoveryAction",
  "webContainerLive",
  "renderIframe",
]);
const frameSource = previewComponent.body.statements
  .filter(
    (node) =>
      ts.isVariableStatement(node) &&
      node.declarationList.declarations.some((declaration) =>
        frameVariables.has(declaration.name.getText(previewSource)),
      ),
  )
  .map((node) => node.getText(previewSource))
  .join("\n");

function evaluate(source: string, context: Record<string, unknown>, result: string) {
  const code = ts.transpileModule(source, {
    fileName: "preview-lifecycle-harness.tsx",
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      jsx: ts.JsxEmit.React,
    },
  }).outputText;
  return new Function(...Object.keys(context), code + "\nreturn " + result + ";")(
    ...Object.values(context),
  );
}

const getContainerStatus = vi.fn();
const startContainer = vi.fn();
const stopContainer = vi.fn();
const runTestEnvironmentAction = vi.fn();
type LifecycleState = {
  containerStatus: string;
  containerStarting: boolean;
  previewAccess: "direct" | "gateway" | "unavailable";
  previewRecoveryError: PreviewRecoveryError | null;
  containerAuthorizationStatus: 401 | 403 | null;
  containerActionPending: "start" | "stop" | null;
  refreshContainerStatus: () => Promise<string | null>;
  handleStartContainer: () => void;
  handleStopContainer: () => void;
};
const useLifecycle = evaluate(
  "const useLifecycle = (projectId: number, project: { id: number; containerStatus: string }) => {\n" +
    lifecycleSource +
    "\nreturn { containerStatus, containerStarting, previewAccess, previewRecoveryError, " +
    "containerAuthorizationStatus, containerActionPending, refreshContainerStatus, handleStartContainer, handleStopContainer };\n};",
  {
    useState: React.useState,
    useRef: React.useRef,
    useEffect: React.useEffect,
    useCallback: React.useCallback,
    getContainerStatus,
    startContainer,
    stopContainer,
    isPreviewAuthorizationStatus,
    isTerminalPreviewRecoveryError,
    readPreviewRecoveryError,
    reconcilePreviewRecoveryError,
  },
  "useLifecycle",
) as (projectId: number, project: { id: number; containerStatus: string }) => LifecycleState;

function previewFrame(state: LifecycleState, projectId: number): React.ReactElement {
  return evaluate(
    frameSource,
    {
      React,
      project: { id: projectId, builderMode: "agentic", containerId: "runtime" },
      containerStatus: state.containerStatus,
      previewAccess: state.previewAccess,
      previewRecoveryError: state.previewRecoveryError,
      containerAuthorizationStatus: state.containerAuthorizationStatus,
      containerActionPending: state.containerActionPending,
      previewResponseAuthorizationStatus: null,
      rebuildRequired: state.previewRecoveryError?.kind === "rebuild-required",
      testEnvironmentStatus: null,
      testEnvironmentBusy: false,
      effectiveTestingStatus: "idle",
      startTestingAction: "start",
      testEnvironmentError: null,
      runTestEnvironmentAction,
      onStartContainer: state.handleStartContainer,
      onRefreshContainerStatus: state.refreshContainerStatus,
      setIframeKey: vi.fn(),
      isReactVite: false,
      wc: { status: "idle", previewUrl: null },
      previewSrc: "/api/projects/" + projectId + "/preview/",
      device: "desktop",
      iframeKey: 0,
      iframeRef: { current: null },
      navigationRequest: null,
      handleIframeLoad: vi.fn(),
      getPreviewIframeSandbox,
      hasServerPreviewAccess,
      presentPreviewRecovery,
      cn: (...values: unknown[]) => values.filter(Boolean).join(" "),
      ServerCrash: () => null,
      Button: ({
        children,
        onClick,
        disabled,
        type,
      }: React.ButtonHTMLAttributes<HTMLButtonElement>) =>
        React.createElement("button", { onClick, disabled, type }, children),
    },
    "renderIframe()",
  );
}

function mountLifecycle(projectId = 60) {
  let latest!: LifecycleState;
  function Harness(props: { projectId: number }) {
    const project = React.useMemo(
      () => ({ id: props.projectId, containerStatus: "stopped" }),
      [props.projectId],
    );
    latest = useLifecycle(props.projectId, project);
    return previewFrame(latest, props.projectId);
  }
  const view = render(<Harness projectId={projectId} />);
  return {
    ...view,
    get current() {
      return latest;
    },
    navigate: (nextProjectId: number) => view.rerender(<Harness projectId={nextProjectId} />),
  };
}

function deferredResponse() {
  let resolveResponse!: (value: unknown) => void;
  let rejectResponse!: (error: unknown) => void;
  const promise = new Promise<unknown>((resolvePromise, rejectPromise) => {
    resolveResponse = resolvePromise;
    rejectResponse = rejectPromise;
  });
  return { promise, resolve: resolveResponse, reject: rejectResponse };
}

const offline = { containerStatus: "stopped", previewAccess: "unavailable" };
const running = { containerStatus: "running", previewAccess: "gateway" };
const rebuild = {
  status: 409,
  data: {
    code: "preview_rebuild_required",
    error: "This preview needs a fresh build before it can be opened.",
  },
};

beforeEach(() => {
  vi.useFakeTimers();
  getContainerStatus.mockResolvedValue(offline);
  startContainer.mockResolvedValue({ containerStatus: "starting", previewAccess: "unavailable" });
  stopContainer.mockResolvedValue({});
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.resetAllMocks();
});

describe("REC06 owned preview actions and read fences", () => {
  type OwnedState = LifecycleState & {
    containerActionPending: "start" | "stop" | null;
    startupDeadline: number | null;
    startupMonitorActive: boolean;
    startupExpired: boolean;
  };
  const stateWrites = vi.fn();
  function useObservedState<T>(initial: T | (() => T)) {
    const [value, setValue] = React.useState(initial);
    const setObservedValue = React.useCallback(
      (next: React.SetStateAction<T>) => {
        stateWrites();
        setValue(next);
      },
      [setValue],
    );
    return [value, setObservedValue] as const;
  }
  const useOwnedLifecycle = evaluate(
    "const useOwnedLifecycle = (projectId: number, project: { id: number; containerStatus: string }) => {\n" +
      lifecycleSource +
      "\nreturn { containerStatus, containerStarting, previewAccess, previewRecoveryError, " +
      "containerAuthorizationStatus, containerActionPending, refreshContainerStatus, " +
      "handleStartContainer, handleStopContainer, " +
      "startupDeadline: containerStartupDeadlineRef.current, " +
      "startupExpired: containerStartupExpiredRef.current, " +
      "startupMonitorActive: containerMonitorActiveRef.current };\n};",
    {
      useState: useObservedState,
      useRef: React.useRef,
      useEffect: React.useEffect,
      useCallback: React.useCallback,
      getContainerStatus,
      startContainer,
      stopContainer,
      isPreviewAuthorizationStatus,
      isTerminalPreviewRecoveryError,
      readPreviewRecoveryError,
      reconcilePreviewRecoveryError,
    },
    "useOwnedLifecycle",
  ) as (projectId: number, project: { id: number; containerStatus: string }) => OwnedState;
  const epoch = Date.UTC(2026, 8, 9, 12);
  const stoppedReceipt = { containerStatus: "stopped", previewAccess: "unavailable" };
  const startingReceipt = { containerStatus: "starting", previewAccess: "unavailable" };
  const runningReceipt = { containerStatus: "running", previewAccess: "gateway" };
  const rebuildReceipt = {
    status: 409,
    data: {
      code: "preview_rebuild_required",
      error: "This preview needs a fresh build before it can be opened.",
    },
  };

  function pending() {
    let resolve!: (value: unknown) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<unknown>((accept, deny) => {
      resolve = accept;
      reject = deny;
    });
    return { promise, resolve, reject };
  }

  function mountOwned(initialStatus = "stopped") {
    let latest!: OwnedState;
    let row = { id: 60, ...stoppedReceipt, containerStatus: initialStatus };
    function Harness({ project }: { project: typeof row }) {
      latest = useOwnedLifecycle(project.id, project);
      return previewFrame(latest, project.id);
    }
    const view = render(<Harness project={row} />);
    return {
      ...view,
      get current() {
        return latest;
      },
      navigate(projectId: number) {
        row = { id: projectId, ...stoppedReceipt };
        view.rerender(<Harness project={row} />);
      },
      refetchRow(containerStatus: string) {
        row = { ...row, containerStatus };
        view.rerender(<Harness project={row} />);
      },
    };
  }

  function expectPendingControl(view: ReturnType<typeof mountOwned>, action: "start" | "stop") {
    expect(view.current.containerActionPending).toBe(action);
    const button = view.container.querySelector<HTMLButtonElement>("button");
    expect(button).not.toBeNull();
    expect(button?.disabled).toBe(true);
    expect(button?.textContent).toMatch(
      action === "start" ? /wak|start|pending/i : /stop|pending/i,
    );
  }

  function expectPendingCheck(view: ReturnType<typeof mountOwned>, action: "start" | "stop") {
    expect(view.current.containerActionPending).toBe(action);
    const button = view.getByRole("button", {
      name: /check|retry|try again/i,
    }) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    return button;
  }

  async function readReceipt(view: ReturnType<typeof mountOwned>, receipt: unknown) {
    getContainerStatus.mockResolvedValueOnce(receipt);
    await act(async () => {
      await view.current.refreshContainerStatus();
    });
  }

  async function readFailure(view: ReturnType<typeof mountOwned>, error: unknown) {
    getContainerStatus.mockRejectedValueOnce(error);
    await act(async () => {
      await view.current.refreshContainerStatus();
    });
  }

  beforeEach(() => {
    // Only the clock and monitor interval are fake; React scheduling stays real.
    vi.useRealTimers();
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    vi.setSystemTime(epoch);
    getContainerStatus.mockReset().mockResolvedValue(stoppedReceipt);
    startContainer.mockReset().mockResolvedValue(startingReceipt);
    stopContainer.mockReset().mockResolvedValue({});
    stateWrites.mockClear();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it.each([null, 401, 403] as const)(
    "keeps owned Wake and its 409 through stopped polling with auth %s",
    async (authorizationStatus) => {
      const wake = pending();
      startContainer.mockReturnValueOnce(wake.promise);
      const view = mountOwned();
      const firstWake = view.current.handleStartContainer;
      act(() => {
        firstWake();
        firstWake();
      });
      expect(startContainer).toHaveBeenCalledTimes(1);
      await readReceipt(view, stoppedReceipt);
      expect(view.current.containerStarting).toBe(false);
      expectPendingControl(view, "start");
      if (authorizationStatus !== null) {
        await readFailure(view, { status: authorizationStatus });
        expectPendingCheck(view, "start");
      }
      act(() => {
        view.current.handleStartContainer();
        firstWake();
      });
      expect(startContainer).toHaveBeenCalledTimes(1);
      await act(async () => {
        wake.reject(rebuildReceipt);
      });
      expect(view.current.containerActionPending).toBeNull();
      expect(view.current.previewRecoveryError?.kind).toBe("rebuild-required");
      expect(view.current.containerAuthorizationStatus).toBe(authorizationStatus);
      expect(view.container.querySelector("iframe")).toBeNull();
      await readReceipt(view, stoppedReceipt);
      expect(view.current.containerAuthorizationStatus).toBeNull();
      expect(view.current.previewRecoveryError?.kind).toBe("rebuild-required");
    },
  );

  it("accepts Wake starting after a terminal poll, then recovers to running", async () => {
    const wake = pending();
    startContainer.mockReturnValueOnce(wake.promise);
    const view = mountOwned();
    act(() => view.current.handleStartContainer());
    await readReceipt(view, stoppedReceipt);
    vi.setSystemTime(epoch + 60_000);
    await act(async () => {
      wake.resolve(startingReceipt);
    });
    expect(view.current.containerActionPending).toBeNull();
    expect(view.current.containerStarting).toBe(true);
    await readReceipt(view, runningReceipt);
    expect(view.current.containerStatus).toBe("running");
    expect(view.current.containerStarting).toBe(false);
    expect(view.container.querySelector("iframe")).not.toBeNull();
  });

  it("resumes only the original Wake deadline after terminal polling", async () => {
    const wake = pending();
    startContainer.mockReturnValueOnce(wake.promise);
    const view = mountOwned();
    act(() => view.current.handleStartContainer());
    await readReceipt(view, stoppedReceipt);
    vi.setSystemTime(epoch + 119_000);
    await act(async () => {
      wake.resolve(startingReceipt);
    });
    expect(view.current.containerStarting).toBe(true);
    const reads = getContainerStatus.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });
    expect(view.current.containerStarting).toBe(false);
    expect(view.current.containerStatus).toBe("error");
    expect(getContainerStatus).toHaveBeenCalledTimes(reads);
  });

  it.each(["running", "stopped"] as const)(
    "accepts owned Stop after a %s terminal poll",
    async (containerStatus) => {
      const stop = pending();
      stopContainer.mockReturnValueOnce(stop.promise);
      const view = mountOwned();
      act(() => view.current.handleStopContainer());
      await readReceipt(view, { containerStatus, previewAccess: "unavailable" });
      expect(view.current.containerActionPending).toBe("stop");
      if (containerStatus === "stopped") expectPendingControl(view, "stop");
      act(() => view.current.handleStopContainer());
      expect(stopContainer).toHaveBeenCalledTimes(1);
      await act(async () => {
        stop.resolve({});
      });
      expect(view.current.containerStatus).toBe("hibernated");
      expect(view.current.containerActionPending).toBeNull();
    },
  );

  it.each(["dispatch", "settlement"] as const)(
    "fences status reads at Wake %s without losing its response",
    async (boundary) => {
      const wake = pending();
      const read = pending();
      startContainer.mockReturnValueOnce(wake.promise);
      const view = mountOwned();
      if (boundary === "settlement") act(() => view.current.handleStartContainer());
      getContainerStatus.mockReturnValueOnce(read.promise);
      let request!: Promise<string | null>;
      act(() => {
        request = view.current.refreshContainerStatus();
      });
      if (boundary === "dispatch") act(() => view.current.handleStartContainer());
      if (boundary === "settlement") {
        await act(async () => {
          wake.resolve(runningReceipt);
        });
      }
      await act(async () => {
        read.resolve(startingReceipt);
        await request;
      });
      if (boundary === "dispatch") {
        expect(view.current.containerActionPending).toBe("start");
        await act(async () => {
          wake.reject(rebuildReceipt);
        });
        expect(view.current.previewRecoveryError?.kind).toBe("rebuild-required");
      } else {
        expect(view.current.containerStatus).toBe("running");
        expect(view.current.containerStarting).toBe(false);
      }
    },
  );

  it.each(["stopped", "hibernated", "error", "running"] as const)(
    "fences pending starting reads after terminal %s without cancelling Wake",
    async (containerStatus) => {
      const wake = pending();
      const read = pending();
      startContainer.mockReturnValueOnce(wake.promise);
      const view = mountOwned();
      act(() => view.current.handleStartContainer());
      getContainerStatus.mockReturnValueOnce(read.promise);
      let request!: Promise<string | null>;
      act(() => {
        request = view.current.refreshContainerStatus();
      });
      await readReceipt(view, { containerStatus, previewAccess: "unavailable" });
      await act(async () => {
        read.resolve(startingReceipt);
        await request;
      });
      expect(view.current.containerStatus).toBe(containerStatus);
      expect(view.current.containerStarting).toBe(false);
      expect(view.current.containerActionPending).toBe("start");
      await act(async () => {
        wake.reject(rebuildReceipt);
      });
      expect(view.current.previewRecoveryError?.kind).toBe("rebuild-required");
    },
  );

  for (const expiry of ["timer", "rejected-503", "rejected-network"] as const) {
    it.each(["rebuild", "running", "starting"] as const)(
      "preserves owned Wake through " + expiry + " expiry and late %s",
      async (result) => {
        const wake = pending();
        const oldRead = pending();
        const expiryRead = pending();
        startContainer.mockReturnValueOnce(wake.promise);
        const view = mountOwned();
        act(() => view.current.handleStartContainer());
        getContainerStatus.mockReturnValueOnce(oldRead.promise);
        let oldRequest!: Promise<string | null>;
        act(() => {
          oldRequest = view.current.refreshContainerStatus();
        });
        let expiryRequest: Promise<string | null> | undefined;
        if (expiry !== "timer") {
          getContainerStatus.mockReturnValueOnce(expiryRead.promise);
          act(() => {
            expiryRequest = view.current.refreshContainerStatus();
          });
        }
        vi.setSystemTime(epoch + 120_001);
        if (expiry === "timer") {
          await act(async () => {
            await vi.advanceTimersByTimeAsync(3_000);
          });
        } else {
          await act(async () => {
            expiryRead.reject(
              expiry === "rejected-503" ? { status: 503 } : new TypeError("Network failed"),
            );
            await expiryRequest;
          });
        }
        expect(view.current.containerStarting).toBe(false);
        expectPendingCheck(view, "start");
        act(() => view.current.handleStartContainer());
        expect(startContainer).toHaveBeenCalledTimes(1);
        await act(async () => {
          oldRead.resolve(startingReceipt);
          await oldRequest;
        });
        expect(view.current.containerStarting).toBe(false);
        expect(view.current.containerStatus).toBe("error");
        await act(async () => {
          if (result === "rebuild") wake.reject(rebuildReceipt);
          else wake.resolve(result === "running" ? runningReceipt : startingReceipt);
        });
        expect(view.current.containerActionPending).toBeNull();
        expect(view.current.containerStarting).toBe(false);
        if (result === "rebuild") {
          expect(view.current.previewRecoveryError?.kind).toBe("rebuild-required");
        } else if (result === "running") {
          expect(view.current.containerStatus).toBe("running");
          expect(view.container.querySelector("iframe")).not.toBeNull();
        } else {
          expect(view.current.containerStatus).toBe("error");
          expect(view.container.querySelector("iframe")).toBeNull();
        }
        const reads = getContainerStatus.mock.calls.length;
        await act(async () => {
          await vi.advanceTimersByTimeAsync(123_000);
        });
        expect(getContainerStatus).toHaveBeenCalledTimes(reads);
        expect(view.current.containerStarting).toBe(false);
      },
    );
  }

  it("keeps Check status available and duplicate Stop blocked after an expired Wake", async () => {
    const wake = pending();
    const stop = pending();
    startContainer.mockReturnValueOnce(wake.promise);
    stopContainer.mockReturnValueOnce(stop.promise);
    const view = mountOwned();
    act(() => view.current.handleStartContainer());
    vi.setSystemTime(epoch + 120_001);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });
    expectPendingCheck(view, "start");
    act(() => view.current.handleStopContainer());
    expect(view.current.containerStarting).toBe(false);
    expectPendingCheck(view, "stop");
    await readReceipt(view, stoppedReceipt);
    expectPendingControl(view, "stop");
    await act(async () => {
      wake.reject(rebuildReceipt);
    });
    expectPendingControl(view, "stop");
    act(() => view.current.handleStopContainer());
    expect(stopContainer).toHaveBeenCalledTimes(1);
    await act(async () => {
      stop.resolve({});
    });
    expect(view.current.containerActionPending).toBeNull();
    expect(view.current.containerStatus).toBe("hibernated");
  });

  it("keeps an owned Stop through rejected-read expiry", async () => {
    const stop = pending();
    stopContainer.mockReturnValueOnce(stop.promise);
    const view = mountOwned();
    await act(async () => {
      view.current.handleStartContainer();
    });
    act(() => view.current.handleStopContainer());
    vi.setSystemTime(epoch + 120_001);
    await readFailure(view, { status: 503 });
    expect(view.current.containerStarting).toBe(false);
    expectPendingCheck(view, "stop");
    act(() => view.current.handleStopContainer());
    expect(stopContainer).toHaveBeenCalledTimes(1);
    await act(async () => {
      stop.resolve({});
    });
    expect(view.current.containerActionPending).toBeNull();
    expect(view.current.containerStatus).toBe("hibernated");
  });

  it.each(["start", "stop"] as const)(
    "allows an actual status check while the owned %s request remains pending",
    async (action) => {
      const wake = pending();
      const stop = pending();
      startContainer.mockReturnValueOnce(wake.promise);
      stopContainer.mockReturnValueOnce(stop.promise);
      const view = mountOwned();
      act(() => view.current.handleStartContainer());
      vi.setSystemTime(epoch + 120_001);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3_000);
      });
      if (action === "stop") act(() => view.current.handleStopContainer());
      const check = expectPendingCheck(view, action);
      const starts = startContainer.mock.calls.length;
      const stops = stopContainer.mock.calls.length;
      const reads = getContainerStatus.mock.calls.length;
      getContainerStatus.mockResolvedValueOnce(stoppedReceipt);
      await act(async () => {
        fireEvent.click(check);
      });
      expect(getContainerStatus).toHaveBeenCalledTimes(reads + 1);
      expect(startContainer).toHaveBeenCalledTimes(starts);
      expect(stopContainer).toHaveBeenCalledTimes(stops);
      expectPendingControl(view, action);
      act(() => {
        if (action === "start") view.current.handleStartContainer();
        else view.current.handleStopContainer();
      });
      expect(startContainer).toHaveBeenCalledTimes(starts);
      expect(stopContainer).toHaveBeenCalledTimes(stops);
      await act(async () => {
        if (action === "start") wake.reject(rebuildReceipt);
        else {
          wake.reject(rebuildReceipt);
          stop.resolve({});
        }
      });
      expect(view.current.containerActionPending).toBeNull();
    },
  );

  it.each([
    ["stopped", "starting"],
    ["stopped", "running"],
    ["hibernated", "starting"],
    ["hibernated", "running"],
  ])("checks provider truth when an idle %s project row changes to %s", async (initial, next) => {
    const read = pending();
    getContainerStatus.mockReturnValueOnce(read.promise);
    const view = mountOwned(initial);
    expect(getContainerStatus).not.toHaveBeenCalled();
    view.refetchRow(next);
    expect(getContainerStatus).toHaveBeenCalledTimes(1);
    expect(getContainerStatus).toHaveBeenCalledWith(60);
    expect(view.current.containerStatus).toBe(initial);
    expect(view.current.containerStarting).toBe(false);
    expect(view.container.querySelector("iframe")).toBeNull();
    view.refetchRow(next);
    expect(getContainerStatus).toHaveBeenCalledTimes(1);
    await act(async () => {
      read.resolve(runningReceipt);
    });
    expect(view.current.containerStatus).toBe("running");
    expect(view.current.previewAccess).toBe("gateway");
    expect(view.getByTitle("App preview").getAttribute("src")).toBe("/api/projects/60/preview/");
    expect(startContainer).not.toHaveBeenCalled();
    expect(stopContainer).not.toHaveBeenCalled();
  });

  it.each(["stopped", "denied"] as const)(
    "does not trust a running project row when provider truth is %s",
    async (result) => {
      const read = pending();
      getContainerStatus.mockReturnValueOnce(read.promise);
      const view = mountOwned();
      view.refetchRow("running");
      await act(async () => {
        if (result === "stopped") read.resolve(stoppedReceipt);
        else read.reject({ status: 403 });
      });
      expect(view.current.containerStatus).toBe(result === "stopped" ? "stopped" : "error");
      expect(view.current.previewAccess).toBe("unavailable");
      expect(view.current.containerAuthorizationStatus).toBe(result === "denied" ? 403 : null);
      expect(view.container.querySelector("iframe")).toBeNull();
      expect(startContainer).not.toHaveBeenCalled();
    },
  );

  for (const boundary of ["start", "stop", "navigation", "unmount"] as const) {
    it.each(["success", "failure"] as const)(
      "fences an idle-refetch status " + boundary + " boundary against late %s",
      async (result) => {
        const read = pending();
        getContainerStatus.mockReturnValueOnce(read.promise);
        const view = mountOwned();
        view.refetchRow("starting");
        expect(getContainerStatus).toHaveBeenCalledTimes(1);
        await act(async () => {
          if (boundary === "start") view.current.handleStartContainer();
          else if (boundary === "stop") view.current.handleStopContainer();
          else if (boundary === "navigation") view.navigate(61);
          else view.unmount();
        });
        const expected = view.current;
        stateWrites.mockClear();
        await act(async () => {
          if (result === "success") read.resolve(runningReceipt);
          else read.reject({ status: 401 });
        });
        expect(stateWrites).not.toHaveBeenCalled();
        if (boundary !== "unmount") {
          expect(view.current).toBe(expected);
          expect(view.container.querySelector("iframe")).toBeNull();
        }
      },
    );
  }

  it("does not restart or extend a background startup monitor from refetched rows", async () => {
    getContainerStatus.mockResolvedValue(startingReceipt);
    const view = mountOwned();
    await act(async () => {
      view.refetchRow("starting");
    });
    expect(view.current.containerStarting).toBe(true);
    const reads = getContainerStatus.mock.calls.length;
    view.refetchRow("running");
    expect(getContainerStatus).toHaveBeenCalledTimes(reads);
    expect(view.current.containerStatus).toBe("starting");
    vi.setSystemTime(epoch + 120_001);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });
    expect(view.current.containerStatus).toBe("error");
    expect(view.current.containerStarting).toBe(false);
    view.refetchRow("starting");
    view.refetchRow("running");
    expect(getContainerStatus).toHaveBeenCalledTimes(reads);
    expect(view.current.containerStatus).toBe("error");
    expect(view.current.containerStarting).toBe(false);
    expect(startContainer).not.toHaveBeenCalled();
  });

  async function completeWakeStop(view: ReturnType<typeof mountOwned>) {
    startContainer.mockResolvedValueOnce(runningReceipt);
    await act(async () => {
      view.current.handleStartContainer();
    });
    expect(view.current.containerStatus).toBe("running");
    await act(async () => {
      view.current.handleStopContainer();
    });
    expect(view.current.containerStatus).toBe("hibernated");
    expect(view.current.containerActionPending).toBeNull();
    expect(view.current.startupDeadline).toBe(epoch + 120_000);
    expect(view.current.startupMonitorActive).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  }

  for (const intent of ["hint", "explicit"] as const) {
    for (const elapsed of [0, 180_000]) {
      it.each(["network", "503"] as const)(
        "recovers from a current " + intent + " %s failure after a completed cycle at " + elapsed,
        async (failure) => {
          const view = mountOwned();
          await completeWakeStop(view);
          const deadline = view.current.startupDeadline;
          vi.setSystemTime(epoch + elapsed);
          getContainerStatus.mockRejectedValueOnce(
            failure === "network" ? new Error("Network unavailable") : { status: 503 },
          );
          await act(async () => {
            if (intent === "hint") view.refetchRow("starting");
            else await view.current.refreshContainerStatus();
          });
          expect(getContainerStatus).toHaveBeenCalledTimes(1);
          expect(view.current.containerStatus).toBe("error");
          expect(view.current.startupExpired).toBe(false);
          expect(view.current.startupMonitorActive).toBe(false);
          expect(view.current.startupDeadline).toBe(deadline);
          expect(view.current.containerActionPending).toBeNull();
          expect(vi.getTimerCount()).toBe(0);
          expect(view.container.querySelector("iframe")).toBeNull();
          const check = view.getByRole("button", {
            name: /check|retry|try again/i,
          }) as HTMLButtonElement;
          expect(check.disabled).toBe(false);
          getContainerStatus.mockResolvedValueOnce(runningReceipt);
          await act(async () => {
            view.refetchRow("running");
          });
          expect(getContainerStatus).toHaveBeenCalledTimes(2);
          expect(view.current.containerStatus).toBe("running");
          expect(view.current.previewAccess).toBe("gateway");
          expect(view.current.previewRecoveryError).toBeNull();
          expect(view.current.startupExpired).toBe(false);
          expect(view.current.startupMonitorActive).toBe(false);
          expect(view.current.startupDeadline).toBe(deadline);
          expect(vi.getTimerCount()).toBe(0);
          expect(startContainer).toHaveBeenCalledTimes(1);
          expect(stopContainer).toHaveBeenCalledTimes(1);
          expect(view.container.querySelector("iframe")).not.toBeNull();
        },
      );
    }
  }

  it.each([401, 403] as const)(
    "preserves rebuild and %s denial across closed-window hints until provider recovery",
    async (status) => {
      const view = mountOwned();
      await completeWakeStop(view);
      const deadline = view.current.startupDeadline;
      vi.setSystemTime(epoch + 180_000);
      getContainerStatus.mockRejectedValueOnce(rebuildReceipt);
      await act(async () => {
        view.refetchRow("starting");
      });
      expect(view.current.previewRecoveryError?.kind).toBe("rebuild-required");
      expect(view.current.startupExpired).toBe(false);
      getContainerStatus.mockRejectedValueOnce({ status });
      await act(async () => {
        view.refetchRow("running");
      });
      expect(view.current.containerAuthorizationStatus).toBe(status);
      expect(view.current.previewRecoveryError?.kind).toBe("rebuild-required");
      expect(view.current.startupExpired).toBe(false);
      getContainerStatus.mockResolvedValueOnce(startingReceipt);
      await act(async () => {
        view.refetchRow("starting");
      });
      expect(view.current.containerAuthorizationStatus).toBe(status);
      expect(view.current.previewRecoveryError?.kind).toBe("rebuild-required");
      expect(view.current.containerStarting).toBe(false);
      expect(view.container.querySelector("iframe")).toBeNull();
      await readReceipt(view, stoppedReceipt);
      expect(view.current.containerAuthorizationStatus).toBeNull();
      expect(view.current.previewRecoveryError?.kind).toBe("rebuild-required");
      getContainerStatus.mockResolvedValueOnce(runningReceipt);
      await act(async () => {
        view.refetchRow("running");
      });
      expect(getContainerStatus).toHaveBeenCalledTimes(5);
      expect(view.current.containerStatus).toBe("running");
      expect(view.current.previewRecoveryError).toBeNull();
      expect(view.current.containerAuthorizationStatus).toBeNull();
      expect(view.current.startupExpired).toBe(false);
      expect(view.current.startupMonitorActive).toBe(false);
      expect(view.current.startupDeadline).toBe(deadline);
      expect(vi.getTimerCount()).toBe(0);
      expect(startContainer).toHaveBeenCalledTimes(1);
      expect(stopContainer).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["active-monitor", "pending-start"] as const)(
    "still expires a genuine %s budget observed by a failed read",
    async (ownership) => {
      const wake = pending();
      startContainer.mockReturnValueOnce(wake.promise);
      const view = mountOwned();
      act(() => {
        view.current.handleStartContainer();
      });
      if (ownership === "pending-start") await readReceipt(view, stoppedReceipt);
      expect(view.current.startupMonitorActive).toBe(ownership === "active-monitor");
      expect(view.current.containerActionPending).toBe("start");
      vi.setSystemTime(epoch + 120_001);
      await readFailure(view, { status: 503 });
      expect(view.current.startupExpired).toBe(true);
      expect(view.current.containerStarting).toBe(false);
      expect(view.current.startupMonitorActive).toBe(false);
      expect(view.current.containerStatus).toBe("error");
      expectPendingCheck(view, "start");
      const reads = getContainerStatus.mock.calls.length;
      await act(async () => {
        wake.resolve(startingReceipt);
      });
      expect(view.current.containerActionPending).toBeNull();
      expect(view.current.startupExpired).toBe(true);
      expect(view.current.containerStatus).toBe("error");
      view.refetchRow("starting");
      view.refetchRow("running");
      expect(getContainerStatus).toHaveBeenCalledTimes(reads);
      expect(vi.getTimerCount()).toBe(0);
      await readReceipt(view, runningReceipt);
      expect(getContainerStatus).toHaveBeenCalledTimes(reads + 1);
      expect(view.current.containerStatus).toBe("running");
      expect(view.current.startupExpired).toBe(true);
      expect(view.current.startupMonitorActive).toBe(false);
      expect(view.current.startupDeadline).toBe(epoch + 120_000);
      expect(startContainer).toHaveBeenCalledTimes(1);
      expect(stopContainer).not.toHaveBeenCalled();
    },
  );

  it("allows an explicit starting check to use only the original unexpired closed window", async () => {
    const view = mountOwned();
    await completeWakeStop(view);
    const deadline = view.current.startupDeadline;
    vi.setSystemTime(epoch + 60_000);
    getContainerStatus.mockResolvedValueOnce(startingReceipt);
    await act(async () => {
      view.refetchRow("starting");
    });
    expect(view.current.containerStatus).toBe("hibernated");
    expect(view.current.startupMonitorActive).toBe(false);
    await readReceipt(view, startingReceipt);
    expect(view.current.containerStatus).toBe("starting");
    expect(view.current.startupMonitorActive).toBe(true);
    expect(view.current.startupDeadline).toBe(deadline);
    const reads = getContainerStatus.mock.calls.length;
    vi.setSystemTime(epoch + 120_001);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });
    expect(view.current.startupExpired).toBe(true);
    expect(view.current.containerStatus).toBe("error");
    expect(view.current.startupMonitorActive).toBe(false);
    expect(view.current.startupDeadline).toBe(deadline);
    expect(getContainerStatus).toHaveBeenCalledTimes(reads);
    expect(startContainer).toHaveBeenCalledTimes(1);
    expect(stopContainer).toHaveBeenCalledTimes(1);
  });

  it("does not treat a pending Stop as ownership of the archived startup budget", async () => {
    const view = mountOwned();
    await completeWakeStop(view);
    const deadline = view.current.startupDeadline;
    vi.setSystemTime(epoch + 180_000);
    const stop = pending();
    stopContainer.mockReturnValueOnce(stop.promise);
    act(() => {
      view.current.handleStopContainer();
    });
    await readFailure(view, { status: 503 });
    expectPendingCheck(view, "stop");
    expect(view.current.startupExpired).toBe(false);
    expect(view.current.startupMonitorActive).toBe(false);
    await act(async () => {
      stop.resolve({});
    });
    getContainerStatus.mockResolvedValueOnce(runningReceipt);
    await act(async () => {
      view.refetchRow("running");
    });
    expect(view.current.containerStatus).toBe("running");
    expect(view.current.startupExpired).toBe(false);
    expect(view.current.startupMonitorActive).toBe(false);
    expect(view.current.startupDeadline).toBe(deadline);
    expect(vi.getTimerCount()).toBe(0);
    expect(startContainer).toHaveBeenCalledTimes(1);
    expect(stopContainer).toHaveBeenCalledTimes(2);
  });

  for (const elapsed of [0, 180_000]) {
    it.each(["running", "stopped", "hibernated", "error"] as const)(
      "reconciles terminal %s after completed Wake/Stop at elapsed " + elapsed,
      async (status) => {
        const view = mountOwned();
        await completeWakeStop(view);
        const deadline = view.current.startupDeadline;
        vi.setSystemTime(epoch + elapsed);
        const read = pending();
        getContainerStatus.mockReturnValueOnce(read.promise);
        view.refetchRow("running");
        expect(getContainerStatus).toHaveBeenCalledTimes(1);
        expect(view.current.containerStatus).toBe("hibernated");
        view.refetchRow("running");
        expect(getContainerStatus).toHaveBeenCalledTimes(1);
        await act(async () => {
          read.resolve({
            containerStatus: status,
            previewAccess: status === "running" ? "gateway" : "unavailable",
          });
        });
        expect(view.current.containerStatus).toBe(status);
        expect(view.current.containerStarting).toBe(false);
        expect(view.current.startupMonitorActive).toBe(false);
        expect(view.current.startupDeadline).toBe(deadline);
        expect(vi.getTimerCount()).toBe(0);
        expect(startContainer).toHaveBeenCalledTimes(1);
        expect(stopContainer).toHaveBeenCalledTimes(1);
        expect(view.container.querySelector("iframe") !== null).toBe(status === "running");
      },
    );

    it(
      "does not reopen a completed startup window from a starting hint at elapsed " + elapsed,
      async () => {
        const view = mountOwned();
        await completeWakeStop(view);
        const deadline = view.current.startupDeadline;
        vi.setSystemTime(epoch + elapsed);
        getContainerStatus.mockResolvedValueOnce(startingReceipt);
        await act(async () => {
          view.refetchRow("starting");
        });
        expect(getContainerStatus).toHaveBeenCalledTimes(1);
        expect(view.current.containerStatus).toBe("hibernated");
        expect(view.current.containerStarting).toBe(false);
        expect(view.current.startupMonitorActive).toBe(false);
        expect(view.current.startupDeadline).toBe(deadline);
        expect(vi.getTimerCount()).toBe(0);
        const recovery = view.getByRole("button") as HTMLButtonElement;
        expect(recovery.disabled).toBe(false);
        await act(async () => {
          await vi.advanceTimersByTimeAsync(180_000);
        });
        expect(getContainerStatus).toHaveBeenCalledTimes(1);
        expect(view.current.containerStatus).toBe("hibernated");
        getContainerStatus.mockResolvedValueOnce(runningReceipt);
        await act(async () => {
          view.refetchRow("running");
        });
        expect(getContainerStatus).toHaveBeenCalledTimes(2);
        expect(view.current.containerStatus).toBe("running");
        expect(view.current.startupDeadline).toBe(deadline);
        expect(startContainer).toHaveBeenCalledTimes(1);
        expect(stopContainer).toHaveBeenCalledTimes(1);
      },
    );
  }

  for (const boundary of ["start", "stop", "navigation", "unmount"] as const) {
    it.each(["success", "failure"] as const)(
      "fences a completed-cycle idle hint across " + boundary + " before late %s",
      async (result) => {
        const view = mountOwned();
        await completeWakeStop(view);
        const read = pending();
        getContainerStatus.mockReturnValueOnce(read.promise);
        view.refetchRow("running");
        expect(getContainerStatus).toHaveBeenCalledTimes(1);
        await act(async () => {
          if (boundary === "start") view.current.handleStartContainer();
          else if (boundary === "stop") view.current.handleStopContainer();
          else if (boundary === "navigation") view.navigate(61);
          else view.unmount();
        });
        const expected = view.current;
        stateWrites.mockClear();
        await act(async () => {
          if (result === "success") read.resolve(runningReceipt);
          else read.reject({ status: 403 });
        });
        expect(stateWrites).not.toHaveBeenCalled();
        if (boundary !== "unmount") expect(view.current).toBe(expected);
      },
    );
  }

  it("keeps expired startup hint recovery explicit and accepts an actual status-check click", async () => {
    getContainerStatus.mockResolvedValue(startingReceipt);
    const view = mountOwned();
    await act(async () => {
      view.refetchRow("starting");
    });
    const deadline = view.current.startupDeadline;
    expect(view.current.startupMonitorActive).toBe(true);
    expect(deadline).toBe(epoch + 120_000);
    vi.setSystemTime(epoch + 120_001);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });
    const reads = getContainerStatus.mock.calls.length;
    expect(view.current.containerStatus).toBe("error");
    expect(view.current.startupMonitorActive).toBe(false);
    view.refetchRow("running");
    expect(getContainerStatus).toHaveBeenCalledTimes(reads);
    const check = view.getByRole("button", { name: /check|retry|try again/i }) as HTMLButtonElement;
    expect(check.disabled).toBe(false);
    getContainerStatus.mockResolvedValueOnce(runningReceipt);
    await act(async () => {
      fireEvent.click(check);
    });
    expect(getContainerStatus).toHaveBeenCalledTimes(reads + 1);
    expect(view.current.containerStatus).toBe("running");
    expect(view.current.startupDeadline).toBe(deadline);
    expect(view.current.startupMonitorActive).toBe(false);
    expect(startContainer).not.toHaveBeenCalled();
    expect(stopContainer).not.toHaveBeenCalled();
  });

  it.each(["success", "rebuild"] as const)(
    "lets newer Stop supersede an older Wake %s",
    async (result) => {
      const wake = pending();
      const stop = pending();
      startContainer.mockReturnValueOnce(wake.promise);
      stopContainer.mockReturnValueOnce(stop.promise);
      const view = mountOwned();
      act(() => view.current.handleStartContainer());
      act(() => view.current.handleStopContainer());
      await act(async () => {
        if (result === "success") wake.resolve(runningReceipt);
        else wake.reject(rebuildReceipt);
      });
      expect(view.current.containerActionPending).toBe("stop");
      expect(view.current.previewRecoveryError).toBeNull();
      expect(view.current.containerStatus).not.toBe("running");
      await act(async () => {
        stop.resolve({});
      });
      expect(view.current.containerStatus).toBe("hibernated");
    },
  );

  it("cannot unlock a newer Wake from obsolete success, rejection, or finally cleanup", async () => {
    const firstWake = pending();
    const stop = pending();
    const newerWake = pending();
    startContainer.mockReturnValueOnce(firstWake.promise).mockReturnValueOnce(newerWake.promise);
    stopContainer.mockReturnValueOnce(stop.promise);
    const view = mountOwned();
    act(() => view.current.handleStartContainer());
    act(() => view.current.handleStopContainer());
    act(() => view.current.handleStartContainer());
    await readReceipt(view, stoppedReceipt);
    await act(async () => {
      firstWake.reject(rebuildReceipt);
      stop.resolve({});
    });
    expect(view.current.containerActionPending).toBe("start");
    expect(view.current.containerStatus).toBe("stopped");
    expect(view.current.previewRecoveryError).toBeNull();
    act(() => view.current.handleStartContainer());
    expect(startContainer).toHaveBeenCalledTimes(2);
    await act(async () => {
      newerWake.resolve(runningReceipt);
    });
    expect(view.current.containerStatus).toBe("running");
    expect(view.current.containerActionPending).toBeNull();
  });

  for (const action of ["start", "stop"] as const) {
    for (const boundary of ["navigation", "round-trip", "unmount"] as const) {
      it.each(["success", "failure"] as const)(
        "fences " + action + " and its reads across " + boundary + " with late %s",
        async (result) => {
          const mutation = pending();
          const read = pending();
          (action === "start" ? startContainer : stopContainer).mockReturnValueOnce(
            mutation.promise,
          );
          const view = mountOwned();
          const staleWake = view.current.handleStartContainer;
          act(() => {
            if (action === "start") view.current.handleStartContainer();
            else view.current.handleStopContainer();
          });
          getContainerStatus.mockReturnValueOnce(read.promise);
          let request!: Promise<string | null>;
          act(() => {
            request = view.current.refreshContainerStatus();
          });
          if (boundary === "unmount") {
            view.unmount();
          } else {
            view.navigate(61);
            if (boundary === "round-trip") view.navigate(60);
            await readFailure(view, { status: 503 });
          }
          const expectedState = view.current;
          stateWrites.mockClear();
          await act(async () => {
            if (result === "success") {
              mutation.resolve(action === "start" ? runningReceipt : {});
              read.resolve(startingReceipt);
            } else {
              mutation.reject(rebuildReceipt);
              read.reject({ status: 401 });
            }
            await request;
          });
          expect(stateWrites).not.toHaveBeenCalled();
          if (boundary !== "unmount") {
            expect(view.current).toBe(expectedState);
            expect(view.current.containerStatus).toBe("error");
            expect(view.current.previewRecoveryError?.kind).not.toBe("rebuild-required");
            expect(view.current.containerAuthorizationStatus).toBeNull();
          }
          const starts = startContainer.mock.calls.length;
          act(() => staleWake());
          expect(startContainer).toHaveBeenCalledTimes(starts);
        },
      );
    }
  }

  it.each(["pending", "terminal", "expired"] as const)(
    "does not let project-row refetch restore startup or release ownership after %s",
    async (boundary) => {
      const wake = pending();
      startContainer.mockReturnValueOnce(wake.promise);
      const view = mountOwned();
      act(() => view.current.handleStartContainer());
      if (boundary === "terminal") await readReceipt(view, stoppedReceipt);
      if (boundary === "expired") {
        vi.setSystemTime(epoch + 120_001);
        await act(async () => {
          await vi.advanceTimersByTimeAsync(3_000);
        });
      }
      const status = view.current.containerStatus;
      const monitoring = view.current.containerStarting;
      const reads = getContainerStatus.mock.calls.length;
      view.refetchRow("starting");
      expect(view.current.containerStatus).toBe(status);
      expect(view.current.containerStarting).toBe(monitoring);
      expect(view.current.containerActionPending).toBe("start");
      expect(getContainerStatus).toHaveBeenCalledTimes(reads);
      view.refetchRow("running");
      expect(view.current.containerStatus).toBe(status);
      expect(view.current.previewAccess).toBe("unavailable");
      act(() => view.current.handleStartContainer());
      expect(startContainer).toHaveBeenCalledTimes(1);
      await act(async () => {
        wake.reject(rebuildReceipt);
      });
      view.refetchRow("starting");
      expect(view.current.previewRecoveryError?.kind).toBe("rebuild-required");
      expect(view.current.containerStarting).toBe(false);
      expect(view.current.containerActionPending).toBeNull();
    },
  );
});

describe("project lifecycle and PreviewTab recovery integration", () => {
  // Fake only the receipt clock and monitor interval; React scheduling stays real.
  function setReceiptClock() {
    vi.useRealTimers();
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    const startedAt = Date.UTC(2026, 8, 9, 12);
    vi.setSystemTime(startedAt);
    return startedAt;
  }

  it.each([
    ["HTTP 503", { status: 503 }],
    ["network failure", new Error("Network unavailable")],
  ])("does not resume a stopped startup monitor after a later %s", async (_label, error) => {
    setReceiptClock();
    const subject = mountLifecycle();
    await act(async () => {
      subject.current.handleStartContainer();
    });
    expect(subject.current.containerStarting).toBe(true);

    getContainerStatus.mockResolvedValueOnce(offline);
    await act(async () => {
      await subject.current.refreshContainerStatus();
    });
    expect(subject.current.containerStatus).toBe("stopped");
    expect(subject.current.containerStarting).toBe(false);

    getContainerStatus.mockRejectedValueOnce(error);
    await act(async () => {
      await subject.current.refreshContainerStatus();
    });
    expect(subject.current.containerStatus).toBe("error");
    expect(subject.current.containerStarting).toBe(false);

    await act(async () => {
      subject.current.handleStartContainer();
    });
    expect(startContainer).toHaveBeenCalledTimes(2);
    expect(subject.current.containerStarting).toBe(true);
  });

  it.each([
    ["HTTP 503", { status: 503 }],
    ["network failure", new Error("Network unavailable")],
  ])(
    "fences pending starting receipts when %s settles after the startup deadline",
    async (_label, error) => {
      const startedAt = setReceiptClock();
      const subject = mountLifecycle();
      await act(async () => {
        subject.current.handleStartContainer();
      });
      const expiredRead = deferredResponse();
      const lateStarting = deferredResponse();
      getContainerStatus
        .mockReturnValueOnce(expiredRead.promise)
        .mockReturnValueOnce(lateStarting.promise);
      act(() => {
        void subject.current.refreshContainerStatus();
        void subject.current.refreshContainerStatus();
      });

      // Settle the rejection after expiry without running the interval's timeout branch.
      vi.setSystemTime(startedAt + 120_001);
      await act(async () => {
        expiredRead.reject(error);
      });
      expect(subject.current.containerStatus).toBe("error");
      expect(subject.current.containerStarting).toBe(false);
      const failureAfterExpiry = subject.current.previewRecoveryError;

      await act(async () => {
        lateStarting.resolve({ containerStatus: "starting", previewAccess: "unavailable" });
      });
      expect(subject.current.containerStatus).toBe("error");
      expect(subject.current.containerStarting).toBe(false);
      expect(subject.current.previewRecoveryError).toBe(failureAfterExpiry);
      expect(subject.container.querySelector("iframe")).toBeNull();
    },
  );

  it.each([
    { request: "status", status: "stopped" },
    { request: "status", status: "hibernated" },
    { request: "status", status: "error" },
    { request: "status", status: "running" },
    { request: "start", status: "stopped" },
    { request: "start", status: "running" },
    { request: "stop", status: "hibernated" },
  ])(
    "keeps a terminal $request/$status receipt when an older starting read settles",
    async ({ request, status }) => {
      setReceiptClock();
      const terminalReceipt = deferredResponse();
      const lateStarting = deferredResponse();
      if (request === "start") startContainer.mockReturnValueOnce(terminalReceipt.promise);
      const subject = mountLifecycle();
      await act(async () => {
        subject.current.handleStartContainer();
      });

      if (request === "stop") {
        stopContainer.mockReturnValueOnce(terminalReceipt.promise);
        act(() => subject.current.handleStopContainer());
      }
      if (request === "status") getContainerStatus.mockReturnValueOnce(terminalReceipt.promise);
      getContainerStatus.mockReturnValueOnce(lateStarting.promise);
      act(() => {
        if (request === "status") void subject.current.refreshContainerStatus();
        void subject.current.refreshContainerStatus();
      });

      const previewAccess = status === "running" ? "gateway" : "unavailable";
      await act(async () => {
        terminalReceipt.resolve({ containerStatus: status, previewAccess });
      });
      expect(subject.current.containerStatus).toBe(status);
      expect(subject.current.containerStarting).toBe(false);
      expect(subject.current.previewAccess).toBe(previewAccess);

      await act(async () => {
        lateStarting.resolve({ containerStatus: "starting", previewAccess: "unavailable" });
      });
      expect(subject.current.containerStatus).toBe(status);
      expect(subject.current.containerStarting).toBe(false);
      expect(subject.current.previewAccess).toBe(previewAccess);
      if (status === "running") {
        expect(screen.getByTitle("App preview").getAttribute("src")).toBe(
          "/api/projects/60/preview/",
        );
      } else {
        expect(subject.container.querySelector("iframe")).toBeNull();
      }
    },
  );

  it.each([401, 403])(
    "shows HTTP %s after a rejected wake while retaining rebuild recovery",
    async (status) => {
      startContainer.mockRejectedValueOnce(rebuild);
      const subject = mountLifecycle();
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Wake preview" }));
      });
      expect(subject.current.previewRecoveryError?.kind).toBe("rebuild-required");
      expect(screen.getByRole("button", { name: "Start test" })).toBeTruthy();
      expect(subject.container.querySelector("iframe")).toBeNull();

      getContainerStatus.mockRejectedValueOnce({ status });
      await act(async () => {
        await subject.current.refreshContainerStatus();
      });
      expect(subject.current.previewRecoveryError?.kind).toBe("rebuild-required");
      expect(subject.current.containerAuthorizationStatus).toBe(status);
      expect(screen.getByText("Preview access denied")).toBeTruthy();
      expect(screen.getByRole("button", { name: "Check preview access" })).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Start test" })).toBeNull();
      expect(screen.queryByRole("button", { name: "Wake preview" })).toBeNull();
      expect(subject.container.querySelector("iframe")).toBeNull();

      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Check preview access" }));
      });
      expect(subject.current.containerAuthorizationStatus).toBeNull();
      expect(subject.current.previewRecoveryError?.kind).toBe("rebuild-required");
      expect(screen.getByRole("button", { name: "Start test" })).toBeTruthy();
      expect(startContainer).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    ["HTTP 503", { status: 503 }],
    ["network failure", new Error("Network unavailable")],
  ])("continues startup monitoring through %s and recovers to running", async (_label, error) => {
    getContainerStatus.mockRejectedValueOnce(error).mockResolvedValueOnce(running);
    const subject = mountLifecycle();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Wake preview" }));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });
    expect(subject.current.containerStarting).toBe(true);
    expect(subject.current.containerStatus).toBe("starting");
    expect(subject.container.querySelector("iframe")).toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });
    expect(subject.current.containerStatus).toBe("running");
    expect(subject.current.containerStarting).toBe(false);
    expect(subject.current.previewRecoveryError).toBeNull();
    expect(screen.getByTitle("App preview").getAttribute("src")).toBe("/api/projects/60/preview/");
    expect(getContainerStatus).toHaveBeenCalledTimes(2);
  });

  it("bounds persistent transient startup failures and stops further polling", async () => {
    getContainerStatus.mockRejectedValue({ status: 503 });
    const subject = mountLifecycle();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Wake preview" }));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_000);
    });
    expect(subject.current.containerStarting).toBe(false);
    expect(subject.current.containerStatus).toBe("error");
    const calls = getContainerStatus.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(9_000);
    });
    expect(getContainerStatus).toHaveBeenCalledTimes(calls);
  });

  it.each([401, 403, 404])("stops startup monitoring on terminal HTTP %s", async (status) => {
    getContainerStatus.mockRejectedValue({ status });
    const subject = mountLifecycle();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Wake preview" }));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });
    expect(subject.current.containerStarting).toBe(false);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(9_000);
    });
    expect(getContainerStatus).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["status", "success"],
    ["status", "failure"],
    ["start", "success"],
    ["start", "failure"],
    ["stop", "success"],
  ])(
    "ignores a deferred A %s %s after B has its own status failure",
    async (operation, outcome) => {
      const pending = deferredResponse();
      if (operation === "status") getContainerStatus.mockReturnValueOnce(pending.promise);
      if (operation === "start") startContainer.mockReturnValueOnce(pending.promise);
      if (operation === "stop") stopContainer.mockReturnValueOnce(pending.promise);
      const subject = mountLifecycle(60);
      act(() => {
        if (operation === "status") void subject.current.refreshContainerStatus();
        if (operation === "start") subject.current.handleStartContainer();
        if (operation === "stop") subject.current.handleStopContainer();
      });
      subject.navigate(61);
      getContainerStatus.mockRejectedValueOnce({
        status: 503,
        data: { code: "project_b_status_failed" },
      });
      await act(async () => {
        await subject.current.refreshContainerStatus();
      });
      expect(subject.current.previewRecoveryError?.code).toBe("project_b_status_failed");

      await act(async () => {
        if (outcome === "success") pending.resolve(running);
        else pending.reject({ status: 500, data: { code: "project_a_status_failed" } });
      });
      expect(subject.current.containerStatus).toBe("error");
      expect(subject.current.containerStarting).toBe(false);
      expect(subject.current.previewRecoveryError?.code).toBe("project_b_status_failed");
      expect(subject.current.containerAuthorizationStatus).toBeNull();
      expect(subject.container.querySelector("iframe")).toBeNull();
    },
  );
});
