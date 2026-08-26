const GIT_OBJECT_ID = /^[0-9a-f]{40}$/;
const MAX_RESPONSE_BYTES = 16_384;

export const PRODUCTION_RELEASE_VERIFIER_SEMANTICS =
  "nabuflow-production-release-verifier-v1" as const;

export type ProductionReleaseVerificationReceipt = Readonly<{
  semantics: typeof PRODUCTION_RELEASE_VERIFIER_SEMANTICS;
  baseUrl: string;
  expectedTree: string;
  verifiedAt: string;
  version: {
    status: 200;
    commit: string;
    tree: string;
    builtAt: string;
    durationMs: number;
  };
  health: {
    status: 200;
    serviceStatus: "ok";
    containerSubsystem: "ok";
    encryptionKey: "ok";
    startupMigrations: "ok";
    queueSchemaContract: "ok";
    buildCommit: string;
    durationMs: number;
  };
}>;

export class ProductionReleaseVerificationError extends Error {
  readonly name = "ProductionReleaseVerificationError";

  constructor(
    readonly code:
      | "release_verification_input_invalid"
      | "release_verification_transport_failed"
      | "release_verification_http_failed"
      | "release_verification_response_too_large"
      | "release_verification_response_invalid"
      | "release_verification_tree_mismatch"
      | "release_verification_health_not_ready",
    readonly endpoint: "/api/version" | "/api/healthz" | null,
    readonly status: number | null = null,
  ) {
    super(code);
  }
}

type FetchLike = (
  input: string,
  init?: RequestInit,
) => Promise<{
  status: number;
  text(): Promise<string>;
}>;

type VerificationOptions = {
  baseUrl: string;
  expectedTree: string;
  timeoutMs?: number;
  fetchImpl?: FetchLike;
  now?: () => Date;
  monotonicNow?: () => number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeBaseUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new ProductionReleaseVerificationError("release_verification_input_invalid", null);
  }
  if (
    !["http:", "https:"].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    throw new ProductionReleaseVerificationError("release_verification_input_invalid", null);
  }
  parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  return parsed.toString().replace(/\/$/, "");
}

async function readJson(
  fetchImpl: FetchLike,
  baseUrl: string,
  endpoint: "/api/version" | "/api/healthz",
  timeoutMs: number,
  monotonicNow: () => number,
): Promise<{ body: Record<string, unknown>; durationMs: number }> {
  const startedAt = monotonicNow();
  let response: Awaited<ReturnType<FetchLike>>;
  try {
    response = await fetchImpl(`${baseUrl}${endpoint}`, {
      method: "GET",
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new ProductionReleaseVerificationError("release_verification_transport_failed", endpoint);
  }
  const durationMs = Math.max(0, Math.round(monotonicNow() - startedAt));
  if (response.status !== 200) {
    throw new ProductionReleaseVerificationError(
      "release_verification_http_failed",
      endpoint,
      response.status,
    );
  }
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES) {
    throw new ProductionReleaseVerificationError(
      "release_verification_response_too_large",
      endpoint,
      response.status,
    );
  }
  try {
    const body = JSON.parse(text) as unknown;
    if (!isRecord(body)) throw new Error("not_object");
    return { body, durationMs };
  } catch {
    throw new ProductionReleaseVerificationError(
      "release_verification_response_invalid",
      endpoint,
      response.status,
    );
  }
}

export async function verifyProductionRelease(
  options: VerificationOptions,
): Promise<ProductionReleaseVerificationReceipt> {
  if (!GIT_OBJECT_ID.test(options.expectedTree)) {
    throw new ProductionReleaseVerificationError("release_verification_input_invalid", null);
  }
  const baseUrl = normalizeBaseUrl(options.baseUrl);
  const timeoutMs = options.timeoutMs ?? 15_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    throw new ProductionReleaseVerificationError("release_verification_input_invalid", null);
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  const monotonicNow = options.monotonicNow ?? performance.now.bind(performance);
  const now = options.now ?? (() => new Date());

  const version = await readJson(fetchImpl, baseUrl, "/api/version", timeoutMs, monotonicNow);
  const { commit, tree, builtAt } = version.body;
  if (
    typeof commit !== "string" ||
    !GIT_OBJECT_ID.test(commit) ||
    typeof tree !== "string" ||
    !GIT_OBJECT_ID.test(tree) ||
    typeof builtAt !== "string" ||
    !Number.isFinite(Date.parse(builtAt))
  ) {
    throw new ProductionReleaseVerificationError(
      "release_verification_response_invalid",
      "/api/version",
      200,
    );
  }
  if (tree !== options.expectedTree) {
    throw new ProductionReleaseVerificationError(
      "release_verification_tree_mismatch",
      "/api/version",
      200,
    );
  }

  const health = await readJson(fetchImpl, baseUrl, "/api/healthz", timeoutMs, monotonicNow);
  const healthReady =
    health.body.status === "ok" &&
    health.body.containerSubsystem === "ok" &&
    health.body.encryptionKey === "ok" &&
    health.body.startupMigrations === "ok" &&
    health.body.queueSchemaContract === "ok" &&
    typeof health.body.buildCommit === "string" &&
    GIT_OBJECT_ID.test(health.body.buildCommit) &&
    health.body.buildCommit === commit;
  if (!healthReady) {
    throw new ProductionReleaseVerificationError(
      "release_verification_health_not_ready",
      "/api/healthz",
      200,
    );
  }

  return {
    semantics: PRODUCTION_RELEASE_VERIFIER_SEMANTICS,
    baseUrl,
    expectedTree: options.expectedTree,
    verifiedAt: now().toISOString(),
    version: {
      status: 200,
      commit,
      tree,
      builtAt,
      durationMs: version.durationMs,
    },
    health: {
      status: 200,
      serviceStatus: "ok",
      containerSubsystem: "ok",
      encryptionKey: "ok",
      startupMigrations: "ok",
      queueSchemaContract: "ok",
      buildCommit: health.body.buildCommit as string,
      durationMs: health.durationMs,
    },
  };
}
