const BUILDER_CHUNK_RECOVERY_PREFIX = "mustaflow:builder-chunk-recovery:v2";
const BUILDER_CHUNK_RETRY_PARAM = "mustaflow_chunk_retry";

export const BUILDER_CHUNK_REFRESHING_MESSAGE = "NabuFlow was updated — refreshing…";

const CHUNK_FAILURE_PATTERNS = [
  /chunkloaderror/i,
  /loading chunk .+ failed/i,
  /failed to fetch dynamically imported module/i,
  /error loading dynamically imported module/i,
  /importing a module script failed/i,
  /failed to load module script/i,
  /expected a javascript(?:-or-wasm)? module script.*mime type/i,
  /non-javascript mime type/i,
  /unable to preload css/i,
];

const CHUNK_DIAGNOSTIC_LIMIT = 480;
const CHUNK_DIAGNOSTIC_SECRET_PATTERNS = [
  /\b(?:sk|rk)_(?:test|live)_[A-Za-z0-9_-]+\b/g,
  /-----BEGIN [^-\r\n]+-----[\s\S]*?-----END [^-\r\n]+-----/g,
];

const BUILDER_ROUTE_PREFIXES = [
  "/projects",
  "/knowledge",
  "/vault",
  "/memory",
  "/library",
  "/settings",
  "/admin",
  "/trash",
  "/billing",
  "/image-studio",
  "/published",
  "/integrations",
  "/security",
  "/learn",
  "/workspaces",
  "/account/domains",
  "/orgs",
];

type ChunkRecoveryStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export type BuilderChunkFailure = {
  pathname: string;
  error: unknown;
  assetUrl?: string | null;
};

export type BuilderChunkRuntime = {
  pathname: string;
  origin: string;
  storage: ChunkRecoveryStorage;
  reload: () => void;
  importModule: <T>(url: string) => Promise<T>;
  showRefreshing: () => void;
  scheduleReload: (reload: () => void) => void;
  retryToken: () => string;
};

export class BuilderChunkReloadPendingError extends Error {
  override name = "BuilderChunkReloadPendingError";

  constructor(options?: ErrorOptions) {
    super(BUILDER_CHUNK_REFRESHING_MESSAGE, options);
  }
}

export class BuilderChunkRecoveryError extends Error {
  override name = "BuilderChunkRecoveryError";

  constructor(options?: ErrorOptions) {
    const diagnostic = chunkFailureDiagnostic(options?.cause);
    super(`NabuFlow could not finish loading this workspace. ${diagnostic}`, options);
  }
}

function sanitizeChunkDiagnosticText(value: string): string {
  let sanitized = value.replace(/[\r\n\t]+/g, " ");
  for (const pattern of CHUNK_DIAGNOSTIC_SECRET_PATTERNS) {
    sanitized = sanitized.replace(pattern, "[redacted]");
  }
  sanitized = sanitized.replace(/(https?:\/\/[^\s?#]+)[?#][^\s]*/gi, "$1?[redacted]");
  return sanitized.slice(0, CHUNK_DIAGNOSTIC_LIMIT);
}

export function chunkFailureDiagnostic(error: unknown): string {
  const candidate =
    error && typeof error === "object"
      ? (error as { name?: unknown; message?: unknown })
      : undefined;
  const name =
    candidate && typeof candidate.name === "string"
      ? sanitizeChunkDiagnosticText(candidate.name)
      : typeof error;
  const message =
    candidate && typeof candidate.message === "string"
      ? sanitizeChunkDiagnosticText(candidate.message)
      : sanitizeChunkDiagnosticText(String(error));
  return `[retry ${name}: ${message}]`;
}

export function isBuilderRoute(pathname: string): boolean {
  return BUILDER_ROUTE_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

function failureMessage(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  if (typeof error === "string") return error;
  if (error && typeof error === "object") {
    const candidate = error as { name?: unknown; message?: unknown };
    return [candidate.name, candidate.message]
      .filter((part): part is string => typeof part === "string")
      .join(": ");
  }
  return "";
}

function errorUrlCandidate(error: unknown): string | null {
  if (!error || typeof error !== "object") return null;
  const candidate = error as {
    url?: unknown;
    src?: unknown;
    request?: unknown;
  };
  for (const value of [candidate.url, candidate.src, candidate.request]) {
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}

export function chunkAssetUrlFromError(error: unknown): string | null {
  const direct = errorUrlCandidate(error);
  if (direct) return direct;

  const message = failureMessage(error);
  const match = message.match(
    /(?:https?:\/\/[^\s"'<>]+|\/assets\/[^\s"'<>]+)\.(?:js|css)(?:\?[^\s"'<>]*)?/i,
  );
  return match?.[0] ?? null;
}

function browserOrigin(): string {
  return typeof window === "undefined" ? "https://mustaflow.invalid" : window.location.origin;
}

function isHashedBuilderAsset(assetUrl: string | null | undefined): boolean {
  if (!assetUrl) return false;
  try {
    const url = new URL(assetUrl, browserOrigin());
    return (
      url.origin === browserOrigin() &&
      url.pathname.startsWith("/assets/") &&
      /-[A-Za-z0-9_-]{6,}\.(?:js|css)$/.test(url.pathname)
    );
  } catch {
    return false;
  }
}

export function isBuilderChunkLoadFailure({
  pathname,
  error,
  assetUrl,
}: BuilderChunkFailure): boolean {
  if (!isBuilderRoute(pathname)) return false;
  const message = failureMessage(error);
  return (
    CHUNK_FAILURE_PATTERNS.some((pattern) => pattern.test(message)) ||
    isHashedBuilderAsset(assetUrl)
  );
}

function recoveryMarkerKey(pathname: string): string {
  return `${BUILDER_CHUNK_RECOVERY_PREFIX}:${pathname}`;
}

export function attemptBuilderChunkRecovery(
  failure: BuilderChunkFailure,
  storage: ChunkRecoveryStorage,
  reload: () => void,
): boolean {
  if (!isBuilderChunkLoadFailure(failure)) return false;
  const markerKey = recoveryMarkerKey(failure.pathname);
  try {
    if (storage.getItem(markerKey) === "reload-requested") return false;
    storage.setItem(markerKey, "reload-requested");
  } catch {
    // Without a durable one-shot marker, reloading could create a loop.
    return false;
  }
  reload();
  return true;
}

export function clearBuilderChunkReloadGuard(
  pathname: string,
  storage: Pick<Storage, "removeItem">,
): void {
  try {
    storage.removeItem(recoveryMarkerKey(pathname));
  } catch {
    // A manual reload remains useful even when browser storage is unavailable.
  }
}

export function cacheBustedChunkUrl(
  assetUrl: string,
  retryToken: string,
  origin = browserOrigin(),
): string {
  const url = new URL(assetUrl, origin);
  if (url.origin !== origin || !url.pathname.startsWith("/assets/")) {
    throw new Error("Refusing to import a chunk outside the NabuFlow asset origin.");
  }
  url.searchParams.set(BUILDER_CHUNK_RETRY_PARAM, retryToken);
  return url.href;
}

function defaultImportModule<T>(url: string): Promise<T> {
  return import(/* @vite-ignore */ url) as Promise<T>;
}

export function showBuilderChunkRefreshing(doc: Document = document): void {
  if (doc.querySelector("[data-builder-chunk-refreshing]")) return;

  const dark =
    doc.documentElement.classList.contains("dark") ||
    (typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-color-scheme: dark)").matches === true);
  const status = doc.createElement("div");
  status.dataset.builderChunkRefreshing = "true";
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  status.textContent = BUILDER_CHUNK_REFRESHING_MESSAGE;
  Object.assign(status.style, {
    position: "fixed",
    inset: "0",
    zIndex: "2147483647",
    display: "grid",
    placeItems: "center",
    padding: "24px",
    background: dark ? "#09090b" : "#fafafa",
    color: dark ? "#e4e4e7" : "#27272a",
    font: "500 14px/1.5 ui-sans-serif, system-ui, sans-serif",
    letterSpacing: "-0.01em",
  });
  doc.body.append(status);
}

function defaultRuntime(): BuilderChunkRuntime {
  return {
    pathname: window.location.pathname,
    origin: window.location.origin,
    storage: window.sessionStorage,
    reload: () => window.location.reload(),
    importModule: defaultImportModule,
    showRefreshing: () => showBuilderChunkRefreshing(),
    scheduleReload: (reload) => {
      window.setTimeout(reload, 120);
    },
    retryToken: () => `${Date.now()}`,
  };
}

function runtimeWithDefaults(overrides?: Partial<BuilderChunkRuntime>): BuilderChunkRuntime {
  return { ...defaultRuntime(), ...overrides };
}

const handledChunkErrors = new WeakSet<object>();

function markChunkErrorHandled(error: unknown): void {
  if (error && typeof error === "object") handledChunkErrors.add(error);
}

function wasChunkErrorHandled(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && handledChunkErrors.has(error));
}

function requestBuilderChunkReload(
  failure: BuilderChunkFailure,
  runtime: BuilderChunkRuntime,
): boolean {
  return attemptBuilderChunkRecovery(failure, runtime.storage, () => {
    runtime.showRefreshing();
    runtime.scheduleReload(runtime.reload);
  });
}

export async function retryBuilderChunkImport<T>(
  importer: () => Promise<T>,
  runtimeOverrides?: Partial<BuilderChunkRuntime>,
): Promise<T> {
  try {
    return await importer();
  } catch (firstError) {
    const runtime = runtimeWithDefaults(runtimeOverrides);
    const assetUrl = chunkAssetUrlFromError(firstError);
    const failure = {
      pathname: runtime.pathname,
      error: firstError,
      assetUrl,
    };
    if (!isBuilderChunkLoadFailure(failure)) throw firstError;
    markChunkErrorHandled(firstError);

    try {
      if (assetUrl) {
        const retryUrl = cacheBustedChunkUrl(assetUrl, runtime.retryToken(), runtime.origin);
        return await runtime.importModule<T>(retryUrl);
      }
      return await importer();
    } catch (retryError) {
      if (requestBuilderChunkReload(failure, runtime)) {
        throw new BuilderChunkReloadPendingError({ cause: retryError });
      }
      throw new BuilderChunkRecoveryError({ cause: retryError });
    }
  }
}

function eventAssetUrl(event: Event): string | null {
  const target = event.target;
  if (target instanceof HTMLScriptElement) return target.src;
  if (target instanceof HTMLLinkElement) return target.href;
  return null;
}

let installed = false;

/**
 * Catch any Builder chunk failure that did not flow through builderLazy.
 * Wrapped lazy imports mark their error in the next microtask, so this global
 * fallback waits one macrotask before requesting the guarded reload.
 */
export function installBuilderChunkRecovery(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;

  const recoverUnwrapped = (error: unknown, assetUrl?: string | null) => {
    const failure = {
      pathname: window.location.pathname,
      error,
      assetUrl: assetUrl ?? chunkAssetUrlFromError(error),
    };
    if (!isBuilderChunkLoadFailure(failure)) return;

    window.setTimeout(() => {
      if (wasChunkErrorHandled(error)) return;
      requestBuilderChunkReload(failure, defaultRuntime());
    }, 0);
  };

  window.addEventListener("vite:preloadError", (event) => {
    const preloadEvent = event as Event & { payload?: unknown };
    recoverUnwrapped(preloadEvent.payload);
  });
  window.addEventListener("unhandledrejection", (event) => {
    recoverUnwrapped(event.reason);
  });
  window.addEventListener(
    "error",
    (event) => {
      recoverUnwrapped(event.error ?? event.message, eventAssetUrl(event));
    },
    true,
  );
}
