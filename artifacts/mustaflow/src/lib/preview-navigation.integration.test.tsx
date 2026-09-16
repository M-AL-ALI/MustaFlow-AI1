import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { useEffect, useRef } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { webContainerPageUrl } from "@/pages/projects/components/page-map-card-model";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VISUAL_EDIT_SCRIPT } from "../../../../lib/tenant-runtime-contracts/src/visual-edit-bridge";
import { usePreviewNavigation } from "@/hooks/use-preview-navigation";
import {
  initialPreviewNavigation,
  normalizePreviewPath,
  pathFromPreviewLocation,
  previewNavigationReducer,
  projectPreviewSource,
} from "./preview-navigation";

const gateway =
  "https://runtime.apps.mustaflow.com/_nabuflow/preview/v1/nrf-ab8e18ef4ebebedd-p61-preview-primary";
const scope = {
  projectId: 61,
  platformOrigin: "https://www.mustaflow.com",
  previewAccess: "gateway" as const,
  revision: 4,
};
afterEach(cleanup);

describe("preview-local location contracts", () => {
  it("extracts the current gateway route without launch grants or the reload marker", () => {
    expect(
      pathFromPreviewLocation(
        gateway + "/notes/123?t=4&tab=edit&__nfg=private#body",
        "https://runtime.apps.mustaflow.com",
        scope,
      ),
    ).toBe("/notes/123?tab=edit#body");
  });
  it.each([
    [gateway.replace("-p61-", "-p51-") + "/notes", "https://runtime.apps.mustaflow.com"],
    [gateway + "/notes", "https://other.test"],
    [gateway + "/%252e%252e/escape", "https://runtime.apps.mustaflow.com"],
    [
      "https://runtime.apps.mustaflow.com/api/projects/51/preview/",
      "https://runtime.apps.mustaflow.com",
    ],
    ["javascript:alert(1)", "null"],
    ["https://user:secret@runtime.apps.mustaflow.com/", "https://runtime.apps.mustaflow.com"],
  ])("rejects a foreign or unsafe location %s", (href, origin) => {
    expect(pathFromPreviewLocation(href, origin, scope)).toBeNull();
  });
  it("keeps database-backed documents opaque and bound to their own project", () => {
    const staticScope = { ...scope, previewAccess: undefined };
    expect(
      pathFromPreviewLocation(
        "https://www.mustaflow.com/api/projects/61/preview/?t=4",
        "null",
        staticScope,
      ),
    ).toBe("/");
    expect(
      pathFromPreviewLocation(
        "https://www.mustaflow.com/api/projects/51/preview/",
        "null",
        staticScope,
      ),
    ).toBeNull();
    expect(
      pathFromPreviewLocation(
        "https://www.mustaflow.com/api/projects/61/preview/",
        "https://www.mustaflow.com",
        staticScope,
      ),
    ).toBeNull();
    expect(
      pathFromPreviewLocation("https://other.test/api/projects/61/preview/", "null", staticScope),
    ).toBeNull();
  });
  it("requires the selected WebContainer or direct runtime origin", () => {
    expect(
      pathFromPreviewLocation("https://wc.test/account?x=1#bio", "https://wc.test", {
        ...scope,
        webContainerUrl: "https://wc.test/",
      }),
    ).toBe("/account?x=1#bio");
    expect(
      pathFromPreviewLocation("https://wc.test/account", "https://other.test", {
        ...scope,
        webContainerUrl: "https://wc.test/",
      }),
    ).toBeNull();
    expect(
      pathFromPreviewLocation("https://direct.test/notes", "https://direct.test", {
        ...scope,
        previewAccess: "direct",
        containerUrl: "https://direct.test",
      }),
    ).toBe("/notes");
  });
  it.each([
    "//evil.test",
    "/%252e%252e/escape",
    "/users/:id",
    "https://evil.test",
    "/a\\b",
    "/a\u0000b",
  ])("rejects unsafe toolbar navigation %s", (path) => {
    expect(normalizePreviewPath(path)).toBeNull();
  });
  it("puts cache invalidation before the fragment, preserving query and Unicode", () => {
    expect(projectPreviewSource(61, "/notes?tab=edit#body", 9)).toBe(
      "/api/projects/61/preview/notes?tab=edit&t=9#body",
    );
    expect(normalizePreviewPath("/\u062d\u0633\u0627\u0628?tab=1#section")).not.toBeNull();
  });
});

describe("atomic preview history", () => {
  it("uses entry identity for native traversal across repeated addresses", () => {
    let state = initialPreviewNavigation();
    const visits = [
      ["/", "home"],
      ["/notes", "list-first"],
      ["/notes/1", "detail-first"],
      ["/notes", "list-second"],
      ["/notes/2", "detail-second"],
    ];
    for (const [path, entryKey] of visits)
      state = previewNavigationReducer(state, { type: "observe", path, entryKey, kind: "push" });
    state = previewNavigationReducer(state, {
      type: "observe",
      path: "/notes/1",
      entryKey: "detail-first",
      kind: "traverse",
    });
    expect(state.index).toBe(2);
    state = previewNavigationReducer(state, {
      type: "observe",
      path: "/notes",
      entryKey: "list-second",
      kind: "traverse",
    });
    expect(state.index).toBe(3);
    state = previewNavigationReducer(state, { type: "step", offset: 1 });
    expect(state.path).toBe("/notes/2");
  });

  it("does not guess a direction when a legacy browser cannot identify repeated entries", () => {
    let state = initialPreviewNavigation();
    for (const path of ["/", "/notes", "/notes/1", "/notes", "/notes/2"])
      state = previewNavigationReducer(state, { type: "observe", path, kind: "push" });
    state = previewNavigationReducer(state, {
      type: "observe",
      path: "/notes/1",
      kind: "traverse",
    });
    state = previewNavigationReducer(state, { type: "observe", path: "/notes", kind: "traverse" });
    expect(state.history).toEqual(["/notes"]);
    expect(state.index).toBe(0);
  });

  it("retains separate visits to the same URL and ignores duplicate reports of one entry", () => {
    let state = initialPreviewNavigation();
    for (const entryKey of ["first", "second", "second"])
      state = previewNavigationReducer(state, {
        type: "observe",
        path: "/",
        entryKey,
        kind: "push",
      });
    expect(state.history).toEqual(["/", "/"]);
    expect(state.entryKeys).toEqual(["first", "second"]);
  });
  it("tracks links and redirects without changing the loaded iframe source", () => {
    let state = initialPreviewNavigation();
    state = previewNavigationReducer(state, { type: "request", path: "/notes/new" });
    const requested = state.requestedPath;
    const revision = state.revision;
    state = previewNavigationReducer(state, { type: "observe", path: "/notes/new", kind: "load" });
    state = previewNavigationReducer(state, { type: "observe", path: "/notes/123", kind: "load" });
    expect(state.path).toBe("/notes/123");
    expect(state.requestedPath).toBe(requested);
    expect(state.revision).toBe(revision);
    state = previewNavigationReducer(state, { type: "reload", revision: (value) => value + 1 });
    expect(state.requestedPath).toBe("/notes/123");
    state = previewNavigationReducer(state, { type: "observe", path: "/notes/123", kind: "load" });
    state = previewNavigationReducer(state, { type: "step", offset: -1 });
    expect(state.path).toBe("/notes/new");
    state = previewNavigationReducer(state, { type: "observe", path: "/notes/new", kind: "load" });
    state = previewNavigationReducer(state, { type: "step", offset: 1 });
    expect(state.path).toBe("/notes/123");
  });
  it("replaces redirected toolbar entries, handles SPA traversal, and truncates a new branch", () => {
    let state = previewNavigationReducer(initialPreviewNavigation(), {
      type: "request",
      path: "/login",
    });
    state = previewNavigationReducer(state, { type: "observe", path: "/dashboard", kind: "load" });
    expect(state.history).toEqual(["/", "/dashboard"]);
    state = previewNavigationReducer(state, { type: "observe", path: "/notes", kind: "push" });
    state = previewNavigationReducer(state, {
      type: "observe",
      path: "/notes?sort=new",
      kind: "replace",
    });
    state = previewNavigationReducer(state, {
      type: "observe",
      path: "/dashboard",
      kind: "traverse",
    });
    expect(state.index).toBe(1);
    state = previewNavigationReducer(state, { type: "request", path: "/settings" });
    expect(state.history).toEqual(["/", "/dashboard", "/settings"]);
  });
  it("bounds history and ignores unsafe reports", () => {
    let state = initialPreviewNavigation();
    for (let index = 0; index < 110; index++)
      state = previewNavigationReducer(state, {
        type: "observe",
        path: "/notes/" + index,
        kind: "push",
      });
    expect(state.history).toHaveLength(100);
    expect(state.index).toBe(99);
    expect(
      previewNavigationReducer(state, { type: "observe", path: "//evil.test", kind: "push" }),
    ).toBe(state);
  });
});

const productionPreview = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), "../pages/projects/components/preview-tab.tsx"),
  "utf8",
);
const autoEffectStart = productionPreview.indexOf(
  "  // Auto-refresh when project finishes building",
);
const autoEffectEnd = productionPreview.indexOf("  const handleIframeLoad", autoEffectStart);
if (autoEffectStart < 0 || autoEffectEnd <= autoEffectStart)
  throw new Error("Production auto-refresh effect not found");
const useProductionBuildEffect = new Function(
  "useEffect",
  "return function useProductionBuildEffect({project,hasFiles,prevStatusRef,setHealthWarning,setConsoleEntries,setCrashBanner,setRollbackBanner,setIframeKey,postBuildWindowRef,postBuildTimerRef}){" +
    productionPreview.slice(autoEffectStart, autoEffectEnd) +
    "\n}",
)(useEffect) as (context: Record<string, unknown>) => void;

function Harness({
  webContainer = false,
  status = "idle",
}: {
  webContainer?: boolean;
  status?: string;
}) {
  const nav = usePreviewNavigation({
    projectId: 61,
    previewAccess: webContainer ? undefined : "gateway",
    webContainerUrl: webContainer ? "https://wc.test/" : null,
  });
  const prevStatusRef = useRef(status);
  const postBuildWindowRef = useRef(false);
  const postBuildTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useProductionBuildEffect({
    project: { status },
    hasFiles: true,
    prevStatusRef,
    setHealthWarning: () => {},
    setConsoleEntries: () => {},
    setCrashBanner: () => {},
    setRollbackBanner: () => {},
    setIframeKey: nav.setIframeKey,
    postBuildWindowRef,
    postBuildTimerRef,
  });
  useEffect(
    () => () => {
      if (postBuildTimerRef.current) clearTimeout(postBuildTimerRef.current);
    },
    [],
  );
  return (
    <div>
      <input
        aria-label="Preview path"
        value={nav.urlInput}
        onChange={(event) => nav.setUrlInput(event.target.value)}
      />
      <button onClick={() => nav.navigateTo(nav.urlInput)}>Go</button>
      <button onClick={nav.reloadPreview}>Reload</button>
      <button disabled={!nav.canGoBack} onClick={nav.goBack}>
        Back
      </button>
      <button disabled={!nav.canGoForward} onClick={nav.goForward}>
        Forward
      </button>
      <iframe
        key={nav.iframeKey}
        ref={nav.iframeRef}
        title="App preview"
        src={
          webContainer
            ? (webContainerPageUrl("https://wc.test/", nav.requestedPath) ?? undefined)
            : projectPreviewSource(61, nav.requestedPath, nav.iframeKey)
        }
        onLoad={nav.onFrameLoad}
      />
    </div>
  );
}
function connectFrame() {
  const frame = screen.getByTitle("App preview") as HTMLIFrameElement;
  const post = vi.spyOn(frame.contentWindow!, "postMessage").mockImplementation(() => {});
  fireEvent.load(frame);
  const nonce = (post.mock.calls.at(-1)![0] as { nonce: string }).nonce;
  const report = (path: string, kind = "load", overrides: Record<string, unknown> = {}) =>
    act(() => {
      window.dispatchEvent(
        new MessageEvent("message", {
          source: frame.contentWindow,
          origin: "https://runtime.apps.mustaflow.com",
          data: {
            __mustaflow_preview: true,
            type: "location",
            nonce,
            href: gateway + path,
            kind,
            ...overrides,
          },
        }),
      );
    });
  return { frame, nonce, report };
}

describe("mounted preview navigation integration", () => {
  it("retains the WebContainer document through the actual automatic build effect, but honors manual reload", () => {
    const view = render(<Harness webContainer />);
    const frame = screen.getByTitle("App preview");
    frame.setAttribute("data-unsaved-form", "retained");
    view.rerender(<Harness webContainer status="building" />);
    view.rerender(<Harness webContainer status="completed" />);
    expect(screen.getByTitle("App preview")).toBe(frame);
    expect(frame).toHaveAttribute("data-unsaved-form", "retained");
    fireEvent.click(screen.getByText("Reload"));
    expect(screen.getByTitle("App preview")).not.toBe(frame);
    expect(screen.getByTitle("App preview")).toHaveAttribute("src", "https://wc.test/");
  });

  it("still refreshes server documents through the actual automatic build effect", () => {
    const view = render(<Harness />);
    const frame = screen.getByTitle("App preview");
    view.rerender(<Harness status="building" />);
    view.rerender(<Harness status="completed" />);
    expect(screen.getByTitle("App preview")).not.toBe(frame);
  });
  it("follows in-app pages without remounting, then reloads the actual current page", () => {
    render(<Harness />);
    const current = connectFrame();
    current.report("/");
    current.frame.setAttribute("data-retained", "unsaved-form");
    current.report("/notes/new", "push");
    current.report("/notes/123", "load");
    expect(screen.getByLabelText("Preview path")).toHaveValue("/notes/123");
    expect(screen.getByTitle("App preview")).toBe(current.frame);
    expect(current.frame).toHaveAttribute("data-retained", "unsaved-form");
    fireEvent.click(screen.getByText("Reload"));
    expect(screen.getByTitle("App preview")).not.toBe(current.frame);
    expect(screen.getByTitle("App preview")).toHaveAttribute(
      "src",
      "/api/projects/61/preview/notes/123?t=1",
    );
    const reloaded = connectFrame();
    reloaded.report("/notes/123?t=1");
    current.report("/stale", "push");
    expect(screen.getByLabelText("Preview path")).toHaveValue("/notes/123");
    fireEvent.click(screen.getByText("Back"));
    expect(screen.getByLabelText("Preview path")).toHaveValue("/notes/new");
    fireEvent.click(screen.getByText("Forward"));
    expect(screen.getByLabelText("Preview path")).toHaveValue("/notes/123");
  });
  it("rejects unrelated frames, wrong subscriptions and cross-project reports", () => {
    render(<Harness />);
    const current = connectFrame();
    current.report("/");
    current.report("/wrong", "push", { nonce: "wrong-subscription" });
    current.report("/wrong", "push", { href: gateway.replace("-p61-", "-p51-") + "/wrong" });
    act(() =>
      window.dispatchEvent(
        new MessageEvent("message", {
          source: window,
          origin: "https://runtime.apps.mustaflow.com",
          data: {
            __mustaflow_preview: true,
            type: "location",
            nonce: current.nonce,
            href: gateway + "/wrong",
            kind: "push",
          },
        }),
      ),
    );
    expect(screen.getByLabelText("Preview path")).toHaveValue("/");
    fireEvent.load(current.frame);
    current.report("/old-document", "push");
    expect(screen.getByLabelText("Preview path")).toHaveValue("/");
  });
  it("preserves query and hash on user-entered navigation", () => {
    render(<Harness />);
    fireEvent.change(screen.getByLabelText("Preview path"), {
      target: { value: "/notes?filter=mine#results" },
    });
    fireEvent.click(screen.getByText("Go"));
    expect(screen.getByTitle("App preview")).toHaveAttribute(
      "src",
      "/api/projects/61/preview/notes?filter=mine&t=1#results",
    );
  });
});

describe("actual injected preview script", () => {
  it("reports native and SPA navigation only after a trusted-parent subscription", () => {
    const listeners = new Map<string, ((event: Record<string, unknown>) => void)[]>();
    const messages: Record<string, unknown>[] = [];
    const location = { href: gateway + "/notes?__nfg=secret" };
    const parent = { postMessage: (message: Record<string, unknown>) => messages.push(message) };
    const fakeWindow = {
      parent,
      location,
      navigation: {
        currentEntry: { key: "initial-entry" },
        addEventListener: (name: string, listener: (event: Record<string, unknown>) => void) =>
          listeners.set(name, [...(listeners.get(name) ?? []), listener]),
      },
      performance: { getEntriesByType: () => [{ type: "navigate" }] },
      addEventListener: (name: string, listener: (event: Record<string, unknown>) => void) =>
        listeners.set(name, [...(listeners.get(name) ?? []), listener]),
      history: {
        pushState(_data: unknown, _unused: string, href: string) {
          location.href = new URL(href, location.href).href;
          return "original-result";
        },
        replaceState(_data: unknown, _unused: string, href: string) {
          location.href = new URL(href, location.href).href;
        },
      },
    };
    const fakeDocument = {
      readyState: "complete",
      getElementById: () => ({}),
      body: { querySelectorAll: () => [] },
      addEventListener: vi.fn(),
    };
    new Function(
      "window",
      "document",
      VISUAL_EDIT_SCRIPT.replace(/^<script>/, "").replace(/<\/script>$/, ""),
    )(fakeWindow, fakeDocument);
    const emit = (name: string, event: Record<string, unknown>) =>
      listeners.get(name)?.forEach((listener) => listener(event));
    const subscribe = {
      __mustaflow_preview: true,
      type: "subscribe",
      nonce: "a-valid-subscription-nonce",
    };
    emit("message", { source: parent, origin: "https://evil.test", data: subscribe });
    expect(messages.filter((message) => message.type === "location")).toHaveLength(0);
    emit("message", { source: {}, origin: "https://www.mustaflow.com", data: subscribe });
    expect(messages.filter((message) => message.type === "location")).toHaveLength(0);
    emit("message", { source: parent, origin: "https://www.mustaflow.com", data: subscribe });
    expect(messages.at(-1)).toMatchObject({
      type: "location",
      kind: "load",
      nonce: subscribe.nonce,
      href: gateway + "/notes",
      entryKey: "initial-entry",
    });
    expect(fakeWindow.history.pushState({}, "", gateway + "/notes/new")).toBe("original-result");
    expect(messages.at(-1)).toMatchObject({ kind: "push", href: gateway + "/notes/new" });
    fakeWindow.history.replaceState({}, "", gateway + "/notes/123#body");
    expect(messages.at(-1)).toMatchObject({ kind: "replace", href: gateway + "/notes/123#body" });
    fakeWindow.navigation.currentEntry.key = "earlier-entry";
    emit("currententrychange", { navigationType: "traverse" });
    expect(messages.at(-1)).toMatchObject({ kind: "traverse", entryKey: "earlier-entry" });
    emit("popstate", {});
    expect(messages.at(-1)).toMatchObject({ kind: "traverse" });
    location.href = gateway + "/notes/123#footer";
    emit("hashchange", {});
    expect(messages.at(-1)).toMatchObject({ kind: "push", href: gateway + "/notes/123#footer" });
  });
});
