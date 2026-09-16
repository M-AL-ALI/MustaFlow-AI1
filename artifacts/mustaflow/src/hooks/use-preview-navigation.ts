import { useCallback, useEffect, useReducer, useRef } from "react";
import {
  initialPreviewNavigation,
  pathFromPreviewLocation,
  previewNavigationReducer,
  type PreviewLocationScope,
  type PreviewNavigationKind,
} from "@/lib/preview-navigation";

type Scope = Omit<PreviewLocationScope, "platformOrigin" | "revision">;

export function usePreviewNavigation(scope: Scope) {
  const [state, dispatch] = useReducer(previewNavigationReducer, undefined, () =>
    initialPreviewNavigation(),
  );
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const subscription = useRef<string | null>(null);
  const previousProject = useRef(scope.projectId);
  const subscribe = useCallback(() => {
    const frame = iframeRef.current?.contentWindow;
    if (!frame) return;
    subscription.current = crypto.randomUUID();
    // A nonce is not a credential. "*" is required by opaque static previews.
    frame.postMessage(
      { __mustaflow_preview: true, type: "subscribe", nonce: subscription.current },
      "*",
    );
  }, []);
  const { projectId, previewAccess, containerUrl, webContainerUrl } = scope;
  useEffect(() => {
    if (previousProject.current !== projectId) {
      previousProject.current = projectId;
      dispatch({ type: "reset" });
    }
    subscription.current = null;
    const receive = (event: MessageEvent) => {
      if (!iframeRef.current || event.source !== iframeRef.current.contentWindow) return;
      const data = event.data;
      if (!data || typeof data !== "object" || data.__mustaflow_preview !== true) return;
      if (data.type === "ready") {
        subscribe();
        return;
      }
      if (
        data.type !== "location" ||
        !subscription.current ||
        data.nonce !== subscription.current ||
        !["load", "push", "replace", "traverse"].includes(data.kind)
      )
        return;
      const path = pathFromPreviewLocation(data.href, event.origin, {
        projectId,
        previewAccess,
        containerUrl,
        webContainerUrl,
        platformOrigin: window.location.origin,
        revision: state.revision,
      });
      if (path !== null)
        dispatch({
          type: "observe",
          path,
          kind: data.kind as PreviewNavigationKind,
          entryKey: typeof data.entryKey === "string" ? data.entryKey : null,
        });
    };
    window.addEventListener("message", receive);
    return () => {
      subscription.current = null;
      window.removeEventListener("message", receive);
    };
  }, [projectId, previewAccess, containerUrl, webContainerUrl, state.revision, subscribe]);
  const navigateTo = useCallback((path: string) => dispatch({ type: "request", path }), []);
  const setUrlInput = useCallback((value: string) => dispatch({ type: "input", value }), []);
  // Existing file/build notifications refresh server/static documents. A live
  // WebContainer already applies those changes through HMR; do not discard it.
  const setIframeKey = useCallback(
    (revision: number | ((previous: number) => number)) => {
      if (!webContainerUrl) dispatch({ type: "reload", revision });
    },
    [webContainerUrl],
  );
  const reloadPreview = useCallback(
    () => dispatch({ type: "reload", revision: (previous) => previous + 1 }),
    [],
  );
  const goBack = useCallback(() => dispatch({ type: "step", offset: -1 }), []);
  const goForward = useCallback(() => dispatch({ type: "step", offset: 1 }), []);
  return {
    iframeRef,
    currentPath: state.path,
    requestedPath: state.requestedPath,
    urlInput: state.input,
    iframeKey: state.revision,
    setIframeKey,
    reloadPreview,
    navigateTo,
    setUrlInput,
    goBack,
    goForward,
    canGoBack: state.index > 0,
    canGoForward: state.index < state.history.length - 1,
    onFrameLoad: subscribe,
  };
}
