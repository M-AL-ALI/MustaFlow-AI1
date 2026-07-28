const BUILDER_CHUNK_RECOVERY_PREFIX = "mustaflow:builder-chunk-recovery:v1";

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

type ChunkRecoveryStorage = Pick<Storage, "getItem" | "setItem">;

export type BuilderChunkFailure = {
  pathname: string;
  error: unknown;
  assetUrl?: string | null;
};

function isBuilderRoute(pathname: string): boolean {
  return pathname === "/projects" || pathname.startsWith("/projects/");
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

function isHashedBuilderAsset(assetUrl: string | null | undefined): boolean {
  if (!assetUrl) return false;
  try {
    const url = new URL(assetUrl, window.location.origin);
    return (
      url.origin === window.location.origin &&
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
  return CHUNK_FAILURE_PATTERNS.some((pattern) => pattern.test(message)) ||
    isHashedBuilderAsset(assetUrl);
}

export function attemptBuilderChunkRecovery(
  failure: BuilderChunkFailure,
  storage: ChunkRecoveryStorage,
  reload: () => void,
): boolean {
  if (!isBuilderChunkLoadFailure(failure)) return false;
  const markerKey = `${BUILDER_CHUNK_RECOVERY_PREFIX}:${failure.pathname}`;
  try {
    if (storage.getItem(markerKey) === "reloaded") return false;
    storage.setItem(markerKey, "reloaded");
  } catch {
    // Without a durable one-shot marker, reloading could create a loop.
    return false;
  }
  reload();
  return true;
}

function eventAssetUrl(event: Event): string | null {
  const target = event.target;
  if (target instanceof HTMLScriptElement) return target.src;
  if (target instanceof HTMLLinkElement) return target.href;
  return null;
}

let installed = false;

/** Install a Builder-gated, one-shot recovery for stale Vite lazy chunks. */
export function installBuilderChunkRecovery(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;

  const recover = (error: unknown, assetUrl?: string | null) =>
    attemptBuilderChunkRecovery(
      {
        pathname: window.location.pathname,
        error,
        assetUrl,
      },
      window.sessionStorage,
      () => window.location.reload(),
    );

  window.addEventListener("vite:preloadError", (event) => {
    const preloadEvent = event as Event & { payload?: unknown };
    if (recover(preloadEvent.payload)) event.preventDefault();
  });
  window.addEventListener("unhandledrejection", (event) => {
    if (recover(event.reason)) event.preventDefault();
  });
  window.addEventListener(
    "error",
    (event) => {
      recover(event.error ?? event.message, eventAssetUrl(event));
    },
    true,
  );
}
