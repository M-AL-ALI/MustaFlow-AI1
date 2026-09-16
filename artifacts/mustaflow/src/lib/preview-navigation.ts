import { pageRouteIsNavigable } from "@/pages/projects/components/page-map-card-model";

export type PreviewNavigationKind = "load" | "push" | "replace" | "traverse";
export type PreviewNavigationState = {
  path: string;
  requestedPath: string;
  input: string;
  history: string[];
  entryKeys: (string | null)[];
  index: number;
  revision: number;
  pending: boolean;
};
export type PreviewNavigationAction =
  | { type: "input"; value: string }
  | { type: "request"; path: string }
  | { type: "observe"; path: string; kind: PreviewNavigationKind; entryKey?: string | null }
  | { type: "step"; offset: -1 | 1 }
  | { type: "reload"; revision: number | ((previous: number) => number) }
  | { type: "reset" };

export function initialPreviewNavigation(revision = 0): PreviewNavigationState {
  return {
    path: "/",
    requestedPath: "/",
    input: "/",
    history: ["/"],
    entryKeys: [null],
    index: 0,
    revision,
    pending: true,
  };
}

/** Local app paths only, including query/hash; never a platform or external URL. */
export function normalizePreviewPath(raw: string): string | null {
  if (
    typeof raw !== "string" ||
    raw.length > 8192 ||
    [...raw].some((character) => character.charCodeAt(0) < 0x20 || character.charCodeAt(0) === 0x7f)
  )
    return null;
  const value = raw.trim() || "/";
  const path = value.startsWith("/") ? value : "/" + value;
  return pageRouteIsNavigable(path.split(/[?#]/, 1)[0]) ? path : null;
}

export function previewNavigationReducer(
  state: PreviewNavigationState,
  action: PreviewNavigationAction,
): PreviewNavigationState {
  if (action.type === "input") return { ...state, input: action.value };
  if (action.type === "reset") return initialPreviewNavigation(state.revision + 1);
  if (action.type === "reload") {
    const revision =
      typeof action.revision === "function" ? action.revision(state.revision) : action.revision;
    return { ...state, requestedPath: state.path, input: state.path, revision, pending: true };
  }
  if (action.type === "step") {
    const index = Math.max(0, Math.min(state.history.length - 1, state.index + action.offset));
    if (index === state.index) return state;
    const path = state.history[index];
    return {
      ...state,
      index,
      path,
      requestedPath: path,
      input: path,
      revision: state.revision + 1,
      pending: true,
    };
  }
  const path = normalizePreviewPath(action.path);
  if (path === null) return state;
  let history = state.history;
  let entryKeys = state.entryKeys;
  let index = state.index;
  const key =
    action.type === "observe" &&
    typeof action.entryKey === "string" &&
    action.entryKey.length > 0 &&
    action.entryKey.length <= 256
      ? action.entryKey
      : null;
  if (action.type === "observe" && (action.kind === "replace" || state.pending)) {
    history = [...history];
    entryKeys = [...entryKeys];
    history[index] = path;
    entryKeys[index] = key;
  } else if (action.type === "observe" && action.kind === "traverse") {
    // URLs are not entry identities: two visits to /notes can surround a detail.
    const matches = history
      .map((entry, position) => ({ entry, position }))
      .filter((entry) => (key !== null ? entryKeys[entry.position] === key : entry.entry === path));
    if (matches.length === 1) {
      index = matches[0].position;
      history = [...history];
      entryKeys = [...entryKeys];
      history[index] = path;
      entryKeys[index] = key;
    } else {
      // Older/opaque browsers may not expose entry identities. Keep the actual
      // observed page, but do not invent a direction for ambiguous native travel.
      history = [path];
      entryKeys = [key];
      index = 0;
    }
  } else if (
    path !== state.path ||
    (action.type === "observe" && key !== null && key !== entryKeys[index])
  ) {
    history = [...history.slice(0, index + 1), path].slice(-100);
    entryKeys = [...entryKeys.slice(0, index + 1), key].slice(-100);
    index = history.length - 1;
  }
  return {
    ...state,
    path,
    input: path,
    history,
    entryKeys,
    index,
    requestedPath: action.type === "request" ? path : state.requestedPath,
    revision: state.revision + (action.type === "request" ? 1 : 0),
    pending: action.type === "request",
  };
}

export function projectPreviewSource(projectId: number, path: string, revision: number): string {
  const target = new URL(normalizePreviewPath(path) ?? "/", "https://preview.invalid");
  target.searchParams.set("t", String(revision));
  return `/api/projects/${projectId}/preview${target.pathname}${target.search}${target.hash}`;
}

export type PreviewLocationScope = {
  projectId: number;
  platformOrigin: string;
  previewAccess?: "direct" | "gateway" | "unavailable";
  containerUrl?: string | null;
  webContainerUrl?: string | null;
  revision: number;
};

/**
 * Location reports describe untrusted app navigation, never readiness or auth.
 * The caller must additionally match the active iframe window and subscription.
 * Gateway URLs are scoped to this project's runtime identity; static previews
 * remain opaque. No platform credentials are sent to the reporting document.
 */
export function pathFromPreviewLocation(
  href: unknown,
  origin: string,
  scope: PreviewLocationScope,
): string | null {
  if (
    typeof href !== "string" ||
    href.length > 16384 ||
    !Number.isSafeInteger(scope.projectId) ||
    scope.projectId <= 0
  )
    return null;
  try {
    const url = new URL(href);
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) return null;
    let path: string;
    if (scope.webContainerUrl) {
      const expected = new URL(scope.webContainerUrl);
      if (url.origin !== expected.origin || origin !== expected.origin) return null;
      path = url.pathname;
    } else if (scope.previewAccess === "gateway") {
      const route =
        /^\/_nabuflow\/preview\/v1\/nrf-[a-f0-9]{16}-p([1-9][0-9]*)-preview-[a-z0-9-]+(\/.*)$/.exec(
          url.pathname,
        );
      if (
        !route ||
        Number(route[1]) !== scope.projectId ||
        origin !== url.origin ||
        url.protocol !== "https:"
      )
        return null;
      path = route[2];
    } else if (scope.previewAccess === "direct" && scope.containerUrl) {
      const expected = new URL(scope.containerUrl);
      if (url.origin !== expected.origin || origin !== expected.origin) return null;
      path = url.pathname;
    } else {
      const prefix = `/api/projects/${scope.projectId}/preview`;
      if (
        origin !== "null" ||
        url.origin !== scope.platformOrigin ||
        !url.pathname.startsWith(prefix + "/")
      )
        return null;
      path = url.pathname.slice(prefix.length);
    }
    url.searchParams.delete("__nfg");
    if (url.searchParams.get("t") === String(scope.revision)) url.searchParams.delete("t");
    return normalizePreviewPath(path + url.search + url.hash);
  } catch {
    return null;
  }
}
