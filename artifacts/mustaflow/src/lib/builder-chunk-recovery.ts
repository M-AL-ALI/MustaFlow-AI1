const BUILDER_CHUNK_RECOVERY_PREFIX = "mustaflow:builder-chunk-recovery:v2";
const BUILDER_CHUNK_FAILURE_PREFIX = "mustaflow:builder-chunk-failure:v1";
const BUILDER_CHUNK_RETRY_PARAM = "mustaflow_chunk_retry";
const BUILDER_CHUNK_RETRY_DELAY_MS = 250;
const BUILDER_CHUNK_PROBE_TIMEOUT_MS = 3_000;

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

export type BuilderChunkFailureStage = "retry" | "global";

export type BuilderChunkFailureRecord = {
  version: 1;
  capturedAt: string;
  routeScope: string;
  stage: BuilderChunkFailureStage;
  errorClass: string;
  message: string;
  assetPath: string | null;
  assetProbe: BuilderChunkAssetProbe;
};

export type BuilderChunkAssetProbe =
  | {
      outcome: "response";
      status: number;
      mediaType: "javascript" | "css" | "other" | "unknown";
    }
  | { outcome: "transport-error"; errorClass: string }
  | { outcome: "unavailable" };

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
  loadStylesheet: (url: string) => Promise<void>;
  waitBeforeRetry: () => Promise<void>;
  showRefreshing: () => void;
  scheduleReload: (reload: () => void) => void;
  retryToken: () => string;
  inspectAsset: (assetUrl: string | null) => Promise<BuilderChunkAssetProbe>;
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

function builderChunkRouteScope(pathname: string): string {
  if (/^\/projects\/[^/]+(?:\/|$)/.test(pathname)) return "project-workspace";
  const matchedPrefix = BUILDER_ROUTE_PREFIXES.find(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
  return matchedPrefix?.replace(/^\//, "").replaceAll("/", "-") || "builder";
}

function chunkFailureStorageKey(pathname: string): string {
  return `${BUILDER_CHUNK_FAILURE_PREFIX}:${builderChunkRouteScope(pathname)}`;
}

function safeErrorClass(error: unknown): string {
  const candidate = error && typeof error === "object" ? (error as { name?: unknown }) : undefined;
  const name = candidate && typeof candidate.name === "string" ? candidate.name : typeof error;
  return name.replace(/[^A-Za-z0-9_.:-]/g, "_").slice(0, 64) || "unknown";
}

function safeChunkAssetPath(
  assetUrl: string | null | undefined,
  origin = browserOrigin(),
): string | null {
  if (!assetUrl) return null;
  try {
    const url = new URL(assetUrl, origin);
    if (
      url.origin !== origin ||
      !url.pathname.startsWith("/assets/") ||
      !/-[A-Za-z0-9_-]{6,}\.(?:js|css)$/.test(url.pathname)
    ) {
      return null;
    }
    return url.pathname.slice(0, 240);
  } catch {
    return null;
  }
}

function safeChunkFailureMessage(error: unknown): string {
  const message = failureMessage(error);
  if (/failed to fetch dynamically imported module/i.test(message)) {
    return "Failed to fetch dynamically imported module.";
  }
  if (/error loading dynamically imported module|importing a module script failed/i.test(message)) {
    return "Dynamic module script failed to load.";
  }
  if (/unable to preload css/i.test(message)) {
    return "Builder stylesheet preload failed.";
  }
  if (
    /expected a javascript(?:-or-wasm)? module script.*mime type|non-javascript mime type/i.test(
      message,
    )
  ) {
    return "Builder module received an invalid MIME type.";
  }
  if (/chunkloaderror|loading chunk .+ failed|failed to load module script/i.test(message)) {
    return "Builder module failed to load.";
  }
  return "Builder asset failed to load.";
}

function safeMediaType(value: string | null): "javascript" | "css" | "other" | "unknown" {
  if (!value) return "unknown";
  const mediaType = value.split(";", 1)[0]?.trim().toLowerCase();
  if (mediaType === "text/javascript" || mediaType === "application/javascript") {
    return "javascript";
  }
  if (mediaType === "text/css") return "css";
  return "other";
}

export async function inspectBuilderChunkAsset(
  assetUrl: string | null,
  options: {
    origin?: string;
    fetcher?: typeof fetch;
    timeoutMs?: number;
  } = {},
): Promise<BuilderChunkAssetProbe> {
  if (!assetUrl) return { outcome: "unavailable" };
  const origin = options.origin ?? browserOrigin();
  let url: URL;
  try {
    url = new URL(assetUrl, origin);
    if (url.origin !== origin || !isHashedBuilderAsset(url.href, origin)) {
      return { outcome: "unavailable" };
    }
    // The hashed path identifies the immutable asset. Never replay query data
    // from an exception into the diagnostic request.
    url.search = "";
    url.hash = "";
  } catch {
    return { outcome: "unavailable" };
  }

  const controller = new AbortController();
  const timeout = globalThis.setTimeout(
    () => controller.abort(),
    options.timeoutMs ?? BUILDER_CHUNK_PROBE_TIMEOUT_MS,
  );
  try {
    const response = await (options.fetcher ?? fetch)(url.href, {
      method: "HEAD",
      cache: "no-store",
      credentials: "same-origin",
      signal: controller.signal,
    });
    return {
      outcome: "response",
      status: response.status,
      mediaType: safeMediaType(response.headers.get("content-type")),
    };
  } catch (error) {
    return { outcome: "transport-error", errorClass: safeErrorClass(error) };
  } finally {
    globalThis.clearTimeout(timeout);
  }
}

function isBuilderChunkAssetProbe(value: unknown): value is BuilderChunkAssetProbe {
  if (!value || typeof value !== "object") return false;
  const probe = value as Partial<BuilderChunkAssetProbe>;
  if (probe.outcome === "unavailable") return true;
  if (probe.outcome === "transport-error") {
    return (
      typeof probe.errorClass === "string" &&
      probe.errorClass.length > 0 &&
      probe.errorClass.length <= 64
    );
  }
  return (
    probe.outcome === "response" &&
    typeof probe.status === "number" &&
    Number.isInteger(probe.status) &&
    probe.status >= 100 &&
    probe.status <= 599 &&
    (probe.mediaType === "javascript" ||
      probe.mediaType === "css" ||
      probe.mediaType === "other" ||
      probe.mediaType === "unknown")
  );
}

export function builderChunkFailureRecord(input: {
  pathname: string;
  stage: BuilderChunkFailureStage;
  error: unknown;
  assetUrl?: string | null;
  assetProbe?: BuilderChunkAssetProbe;
  origin?: string;
  now?: () => number;
}): BuilderChunkFailureRecord {
  return {
    version: 1,
    capturedAt: new Date((input.now ?? Date.now)()).toISOString(),
    routeScope: builderChunkRouteScope(input.pathname),
    stage: input.stage,
    errorClass: safeErrorClass(input.error),
    message: safeChunkFailureMessage(input.error),
    assetPath: safeChunkAssetPath(
      input.assetUrl ?? chunkAssetUrlFromError(input.error),
      input.origin,
    ),
    assetProbe: input.assetProbe ?? { outcome: "unavailable" },
  };
}

export function persistBuilderChunkFailure(
  storage: Pick<Storage, "setItem">,
  input: Parameters<typeof builderChunkFailureRecord>[0],
): BuilderChunkFailureRecord {
  const record = builderChunkFailureRecord(input);
  try {
    storage.setItem(chunkFailureStorageKey(input.pathname), JSON.stringify(record));
  } catch {
    // Diagnostics must never make recovery less reliable.
  }
  return record;
}

export function readBuilderChunkFailure(
  storage: Pick<Storage, "getItem">,
  pathname: string,
): BuilderChunkFailureRecord | null {
  try {
    const raw = storage.getItem(chunkFailureStorageKey(pathname));
    if (!raw || raw.length > 2_048) return null;
    const record = JSON.parse(raw) as Partial<BuilderChunkFailureRecord>;
    if (
      record.version !== 1 ||
      typeof record.capturedAt !== "string" ||
      record.routeScope !== builderChunkRouteScope(pathname) ||
      typeof record.routeScope !== "string" ||
      !/^[a-z0-9-]{1,64}$/.test(record.routeScope) ||
      (record.stage !== "retry" && record.stage !== "global") ||
      typeof record.errorClass !== "string" ||
      record.errorClass.length > 64 ||
      typeof record.message !== "string" ||
      record.message.length > CHUNK_DIAGNOSTIC_LIMIT ||
      (record.assetPath !== null &&
        (typeof record.assetPath !== "string" ||
          !/^\/assets\/[A-Za-z0-9_.-]+-[A-Za-z0-9_-]{6,}\.(?:js|css)$/.test(record.assetPath))) ||
      !isBuilderChunkAssetProbe(record.assetProbe)
    ) {
      return null;
    }
    return record as BuilderChunkFailureRecord;
  } catch {
    return null;
  }
}

export function clearBuilderChunkFailure(
  storage: Pick<Storage, "removeItem">,
  pathname: string,
): void {
  try {
    storage.removeItem(chunkFailureStorageKey(pathname));
  } catch {
    // A successful route load is still authoritative when storage is unavailable.
  }
}

export function chunkFailureDiagnostic(error: unknown): string {
  return `[retry ${safeErrorClass(error)}: ${safeChunkFailureMessage(error)}]`;
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

function isHashedBuilderAsset(
  assetUrl: string | null | undefined,
  origin = browserOrigin(),
): boolean {
  if (!assetUrl) return false;
  try {
    const url = new URL(assetUrl, origin);
    return (
      url.origin === origin &&
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

export function loadBuilderStylesheet(url: string, doc: Document = document): Promise<void> {
  return new Promise((resolve, reject) => {
    const stylesheet = doc.createElement("link");
    stylesheet.rel = "stylesheet";
    stylesheet.href = url;
    stylesheet.addEventListener("load", () => resolve(), { once: true });
    stylesheet.addEventListener(
      "error",
      () => {
        stylesheet.remove();
        reject(new Error("Builder stylesheet retry failed."));
      },
      { once: true },
    );
    doc.head.append(stylesheet);
  });
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
    loadStylesheet: (url) => loadBuilderStylesheet(url),
    waitBeforeRetry: () =>
      new Promise((resolve) => {
        window.setTimeout(resolve, BUILDER_CHUNK_RETRY_DELAY_MS);
      }),
    showRefreshing: () => showBuilderChunkRefreshing(),
    scheduleReload: (reload) => {
      window.setTimeout(reload, 120);
    },
    retryToken: () => `${Date.now()}`,
    inspectAsset: (assetUrl) => inspectBuilderChunkAsset(assetUrl),
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
  stage: BuilderChunkFailureStage,
  diagnosticFailure: BuilderChunkFailure = failure,
  assetProbe: BuilderChunkAssetProbe = { outcome: "unavailable" },
): boolean {
  persistBuilderChunkFailure(runtime.storage, {
    ...diagnosticFailure,
    stage,
    origin: runtime.origin,
    assetProbe,
  });
  return attemptBuilderChunkRecovery(failure, runtime.storage, () => {
    runtime.showRefreshing();
    runtime.scheduleReload(runtime.reload);
  });
}

export async function retryBuilderChunkImport<T>(
  importer: () => Promise<T>,
  runtimeOverrides?: Partial<BuilderChunkRuntime>,
): Promise<T> {
  const runtime = runtimeWithDefaults(runtimeOverrides);
  try {
    const loaded = await importer();
    clearBuilderChunkReloadGuard(runtime.pathname, runtime.storage);
    clearBuilderChunkFailure(runtime.storage, runtime.pathname);
    return loaded;
  } catch (firstError) {
    const assetUrl = chunkAssetUrlFromError(firstError);
    const failure = {
      pathname: runtime.pathname,
      error: firstError,
      assetUrl,
    };
    if (!isBuilderChunkLoadFailure(failure)) throw firstError;
    markChunkErrorHandled(firstError);

    try {
      await runtime.waitBeforeRetry();
      if (assetUrl) {
        const retryUrl = cacheBustedChunkUrl(assetUrl, runtime.retryToken(), runtime.origin);
        if (new URL(retryUrl).pathname.endsWith(".css")) {
          // A Vite preload failure may name the stylesheet that blocked a lazy
          // route. CSS is not a JavaScript module: load a cache-busted stylesheet
          // first, then rerun the original importer so Vite can finish the route.
          await runtime.loadStylesheet(retryUrl);
          const loaded = await importer();
          clearBuilderChunkReloadGuard(runtime.pathname, runtime.storage);
          clearBuilderChunkFailure(runtime.storage, runtime.pathname);
          return loaded;
        }
        const loaded = await runtime.importModule<T>(retryUrl);
        clearBuilderChunkReloadGuard(runtime.pathname, runtime.storage);
        clearBuilderChunkFailure(runtime.storage, runtime.pathname);
        return loaded;
      }
      const loaded = await importer();
      clearBuilderChunkReloadGuard(runtime.pathname, runtime.storage);
      clearBuilderChunkFailure(runtime.storage, runtime.pathname);
      return loaded;
    } catch (retryError) {
      const retryFailure = {
        pathname: runtime.pathname,
        error: retryError,
        assetUrl: chunkAssetUrlFromError(retryError) ?? assetUrl,
      };
      const assetProbe = await runtime.inspectAsset(retryFailure.assetUrl ?? null);
      if (requestBuilderChunkReload(failure, runtime, "retry", retryFailure, assetProbe)) {
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

    window.setTimeout(async () => {
      if (wasChunkErrorHandled(error)) return;
      const runtime = defaultRuntime();
      const assetProbe = await runtime.inspectAsset(failure.assetUrl ?? null);
      requestBuilderChunkReload(failure, runtime, "global", failure, assetProbe);
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
