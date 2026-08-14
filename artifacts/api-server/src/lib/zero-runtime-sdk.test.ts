import { createHash } from "node:crypto";
import { transform } from "esbuild";
import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  runtimeDatabaseCapabilityIntentSchema,
  runtimeDatabaseCapabilityResponseSchema,
  runtimeStripeCapabilityIntentSchema,
  runtimeStripeCapabilityResponseSchema,
} from "@workspace/tenant-runtime-contracts";
import { getVendoredRuntimeSdkFiles } from "./zero-runtime-sdk";

interface LoadedSdk {
  createNabuFlowDatabase(options?: Record<string, unknown>): {
    mode: string;
    query(
      sql: string,
      params?: unknown[],
      options?: Record<string, unknown>,
    ): Promise<Record<string, unknown>>;
    batch(
      statements: Array<{ sql: string; params: unknown[] }>,
      options?: Record<string, unknown>,
    ): Promise<Array<Record<string, unknown>>>;
  };
  createDrizzleProxyAdapter(
    client: unknown,
  ): (sql: string, params: unknown[], method: string) => Promise<{ rows: unknown[] }>;
  NabuFlowDatabaseError: new (...args: unknown[]) => Error & {
    code: string;
    retryable: boolean;
  };
}

interface LoadedPaymentsSdk {
  createNabuFlowPayments(options?: Record<string, unknown>): {
    mode: string;
    createPaymentIntent(input: {
      idempotencyKey: string;
      amount: number;
      currency: string;
    }): Promise<Record<string, unknown>>;
    retrievePaymentIntent(paymentIntentId: string): Promise<Record<string, unknown>>;
  };
}

const originalMode = process.env.NABUFLOW_RUNTIME_MODE;
const originalDatabaseUrl = process.env.DATABASE_URL;

async function loadVendoredSdk(): Promise<LoadedSdk> {
  const source = getVendoredRuntimeSdkFiles().find(
    (file) => file.path === "nabuflow/runtime/db.ts",
  )?.content;
  if (source === undefined) throw new Error("Vendored database SDK source is missing");
  const transformed = await transform(source, {
    format: "cjs",
    loader: "ts",
    target: "node22",
  });
  const module = { exports: {} as Record<string, unknown> };
  const evaluate = new Function("module", "exports", transformed.code) as (
    module: { exports: Record<string, unknown> },
    exports: Record<string, unknown>,
  ) => void;
  evaluate(module, module.exports);
  return module.exports as unknown as LoadedSdk;
}

async function loadVendoredPaymentsSdk(): Promise<LoadedPaymentsSdk> {
  const source = getVendoredRuntimeSdkFiles().find(
    (file) => file.path === "nabuflow/runtime/payments.ts",
  )?.content;
  if (source === undefined) throw new Error("Vendored payments SDK source is missing");
  const transformed = await transform(source, { format: "cjs", loader: "ts", target: "node22" });
  const module = { exports: {} as Record<string, unknown> };
  const evaluate = new Function("module", "exports", transformed.code) as (
    module: { exports: Record<string, unknown> },
    exports: Record<string, unknown>,
  ) => void;
  evaluate(module, module.exports);
  return module.exports as unknown as LoadedPaymentsSdk;
}

function statementResult(rows: Array<Record<string, unknown>>, command = "SELECT") {
  return { command, rowCount: rows.length, rows };
}

function restoreEnvironment(): void {
  if (originalMode === undefined) delete process.env.NABUFLOW_RUNTIME_MODE;
  else process.env.NABUFLOW_RUNTIME_MODE = originalMode;
  if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalDatabaseUrl;
}

beforeEach(() => {
  delete process.env.NABUFLOW_RUNTIME_MODE;
  delete process.env.DATABASE_URL;
});

afterEach(() => {
  restoreEnvironment();
  vi.restoreAllMocks();
});

describe("vendored dual-mode runtime SDK", () => {
  it("emits byte-stable golden files without credentials or generated authority", () => {
    const first = getVendoredRuntimeSdkFiles();
    const second = getVendoredRuntimeSdkFiles();
    expect(second).toEqual(first);
    expect(first.map((file) => file.path)).toEqual([
      "nabuflow/runtime/db.ts",
      "nabuflow/runtime/payments.ts",
      "nabuflow/runtime/index.ts",
    ]);
    expect(first.every((file) => file.content.endsWith("\n") && !file.content.includes("\r"))).toBe(
      true,
    );
    const joined = first.map((file) => `${file.path}\0${file.content}`).join("\0");
    expect(joined).not.toMatch(/postgres(?:ql)?:\/\/|sk_(?:live|test)_|nrf-[a-z0-9]/iu);
    expect(createHash("sha256").update(joined).digest("hex")).toBe(
      "9e44d6d6ebefb4b5e86d769cf0cb952d18e87d743d0bef54b5d477d4a63b832a",
    );
  });

  it("compiles the public index when capability modules share the SDK version export", () => {
    const index = getVendoredRuntimeSdkFiles().find(
      (file) => file.path === "nabuflow/runtime/index.ts",
    )?.content;
    expect(index).toBeDefined();
    const sources = new Map([
      ["/index.ts", index ?? ""],
      ["/db.ts", 'export const NABUFLOW_RUNTIME_SDK_VERSION = "v1"; export const db = true;'],
      [
        "/payments.ts",
        'export const NABUFLOW_RUNTIME_SDK_VERSION = "v1"; export const payments = true;',
      ],
    ]);
    const options: ts.CompilerOptions = {
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Node10,
      noEmit: true,
      skipLibCheck: true,
      target: ts.ScriptTarget.ES2022,
    };
    const host = ts.createCompilerHost(options);
    const originalGetSourceFile = host.getSourceFile.bind(host);
    host.fileExists = (fileName) => sources.has(fileName) || ts.sys.fileExists(fileName);
    host.readFile = (fileName) => sources.get(fileName) ?? ts.sys.readFile(fileName);
    host.getSourceFile = (fileName, languageVersion, onError, shouldCreateNewSourceFile) => {
      const source = sources.get(fileName);
      return source === undefined
        ? originalGetSourceFile(fileName, languageVersion, onError, shouldCreateNewSourceFile)
        : ts.createSourceFile(fileName, source, languageVersion, true);
    };
    const diagnostics = ts.getPreEmitDiagnostics(ts.createProgram(["/index.ts"], options, host));
    expect(diagnostics.filter((diagnostic) => diagnostic.code === 2308)).toEqual([]);
  });

  it("uses the Stripe capability in sealed mode and an injected direct adapter in Fly mode", async () => {
    const paymentIntent = {
      id: "pi_test123",
      status: "requires_payment_method",
      amount: 2500,
      amountReceived: 0,
      currency: "usd",
      created: 1_786_000_000,
      livemode: false as const,
    };

    process.env.NABUFLOW_RUNTIME_MODE = "cloudflare-capability-v1";
    const capabilitySdk = await loadVendoredPaymentsSdk();
    let intentBody: unknown;
    const capabilityClient = capabilitySdk.createNabuFlowPayments({
      directDriver: {
        createPaymentIntent: vi.fn(() => Promise.reject(new Error("direct path used"))),
        retrievePaymentIntent: vi.fn(() => Promise.reject(new Error("direct path used"))),
      },
      fetch: async (_input: string, init: RequestInit) => {
        const intent = runtimeStripeCapabilityIntentSchema.parse(JSON.parse(String(init.body)));
        intentBody = intent;
        return Response.json(
          runtimeStripeCapabilityResponseSchema.parse({
            ok: true,
            capability: intent.capability,
            requestId: intent.requestId,
            runtimeIdentity: "nrf-aaaaaaaaaaaaaaaa-p42-preview-primary",
            actedBy: "stripe-broker",
            operation: "create-payment-intent",
            idempotentReplay: false,
            paymentIntent,
          }),
        );
      },
    });
    expect(
      await capabilityClient.createPaymentIntent({
        idempotencyKey: "zero-payment-idempotency-1",
        amount: 2500,
        currency: "usd",
      }),
    ).toEqual(paymentIntent);
    expect(intentBody).toMatchObject({
      capability: { provider: "stripe", name: "payments" },
      action: "invoke",
      input: { kind: "create-payment-intent" },
    });
    expect(JSON.stringify(intentBody)).not.toMatch(/credential|secret|apiKey|runtimeIdentity/iu);

    process.env.NABUFLOW_RUNTIME_MODE = "fly-direct-v1";
    const directSdk = await loadVendoredPaymentsSdk();
    const createPaymentIntent = vi.fn(async () => paymentIntent);
    const retrievePaymentIntent = vi.fn(async () => paymentIntent);
    const directClient = directSdk.createNabuFlowPayments({
      directDriver: { createPaymentIntent, retrievePaymentIntent },
      fetch: vi.fn(() => Promise.reject(new Error("capability path used"))),
    });
    expect(
      await directClient.createPaymentIntent({
        idempotencyKey: "zero-payment-idempotency-1",
        amount: 2500,
        currency: "usd",
      }),
    ).toEqual(paymentIntent);
    expect(createPaymentIntent).toHaveBeenCalledTimes(1);
  });

  it("fails closed at module initialization for a missing or unknown mode", async () => {
    await expect(loadVendoredSdk()).rejects.toMatchObject({
      name: "NabuFlowDatabaseError",
      code: "configuration",
    });
    process.env.NABUFLOW_RUNTIME_MODE = "auto";
    await expect(loadVendoredSdk()).rejects.toMatchObject({
      name: "NabuFlowDatabaseError",
      code: "configuration",
    });
  });

  it("keeps direct mode lazy, parameterized, frozen, and completely off the capability path", async () => {
    process.env.NABUFLOW_RUNTIME_MODE = "fly-direct-v1";
    process.env.DATABASE_URL = "postgresql://legacy-fake.local/app";
    const sdk = await loadVendoredSdk();
    const fetchImpl = vi.fn(async () => {
      throw new Error("Direct mode must not fetch");
    });
    const query = vi.fn(async (sql: string, params: unknown[]) =>
      statementResult([{ sql, params }]),
    );
    const atomicBatch = vi.fn(async (statements: unknown[]) => [
      statementResult([{ statements }], "BATCH"),
    ]);
    const factory = vi.fn(() => ({ query, atomicBatch }));
    process.env.NABUFLOW_RUNTIME_MODE = "cloudflare-capability-v1";
    const client = sdk.createNabuFlowDatabase({ fetch: fetchImpl, directDriverFactory: factory });

    expect(client.mode).toBe("fly-direct-v1");
    expect(factory).not.toHaveBeenCalled();
    expect(await client.query("select $1::text", ["bound-value"])).toMatchObject({
      rows: [{ sql: "select $1::text", params: ["bound-value"] }],
    });
    expect(factory).toHaveBeenCalledTimes(1);
    expect(factory).toHaveBeenCalledWith("postgresql://legacy-fake.local/app");
    expect(query).toHaveBeenCalledWith("select $1::text", ["bound-value"], {
      signal: expect.any(AbortSignal),
    });
    await client.query("select $1::int", [2]);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("fails direct mode clearly when legacy configuration is missing", async () => {
    process.env.NABUFLOW_RUNTIME_MODE = "fly-direct-v1";
    const sdk = await loadVendoredSdk();
    const client = sdk.createNabuFlowDatabase({
      fetch: vi.fn(),
      directDriverFactory: vi.fn(),
    });
    await expect(client.query("select 1")).rejects.toMatchObject({
      name: "NabuFlowDatabaseError",
      code: "configuration",
      message: "The database runtime is not configured",
    });
  });

  it("emits only the bounded unsigned database intent in capability mode", async () => {
    process.env.NABUFLOW_RUNTIME_MODE = "cloudflare-capability-v1";
    process.env.DATABASE_URL = "must-not-be-read-in-capability-mode";
    const sdk = await loadVendoredSdk();
    let capturedBody = "";
    const directDriverFactory = vi.fn(() => {
      throw new Error("Capability mode must not initialize a direct driver");
    });
    const fetchImpl = vi.fn(async (input: string, init: RequestInit) => {
      expect(input).toBe("http://doorman.staging.nabuflow.internal/v1/invoke");
      const headers = new Headers(init.headers);
      expect(headers.get("authorization")).toBeNull();
      expect(headers.get("cookie")).toBeNull();
      expect(headers.get("x-nabuflow-signature")).toBeNull();
      capturedBody = String(init.body);
      const intent = runtimeDatabaseCapabilityIntentSchema.parse(JSON.parse(capturedBody));
      if (intent.input.kind !== "statement") throw new Error("Expected statement intent");
      const response = runtimeDatabaseCapabilityResponseSchema.parse({
        ok: true,
        capability: intent.capability,
        requestId: intent.requestId,
        runtimeIdentity: "nrf-aaaaaaaaaaaaaaaa-p42-preview-primary",
        actedBy: "database-broker",
        result: {
          kind: "statement",
          result: statementResult([{ value: intent.input.params[0] }]),
        },
      });
      return Response.json(response);
    });
    const client = sdk.createNabuFlowDatabase({ fetch: fetchImpl, directDriverFactory });
    const result = await client.query("select $1::text as value", ["hello"]);
    const intent = JSON.parse(capturedBody) as Record<string, unknown>;

    expect(result).toEqual(statementResult([{ value: "hello" }]));
    expect(client.mode).toBe("cloudflare-capability-v1");
    expect(directDriverFactory).not.toHaveBeenCalled();
    expect(capturedBody).toBe(JSON.stringify(intent));
    expect(capturedBody).not.toMatch(
      /requestedProjectId|runtimeIdentity|containerId|databaseUrl|credential|secret|vault|signature/iu,
    );
    expect(Object.keys(intent)).toEqual(["v", "capability", "action", "requestId", "input"]);
    expect(result).not.toHaveProperty("runtimeIdentity");
  });

  it("ignores attempted cross-tenant authority supplied through call options", async () => {
    process.env.NABUFLOW_RUNTIME_MODE = "cloudflare-capability-v1";
    const sdk = await loadVendoredSdk();
    let captured: Record<string, unknown> = {};
    const client = sdk.createNabuFlowDatabase({
      fetch: async (_input: string, init: RequestInit) => {
        captured = JSON.parse(String(init.body)) as Record<string, unknown>;
        const requestId = String(captured.requestId);
        return Response.json({
          ok: true,
          capability: { provider: "neon-postgres", name: "database" },
          requestId,
          runtimeIdentity: "nrf-aaaaaaaaaaaaaaaa-p42-preview-primary",
          actedBy: "database-broker",
          result: { kind: "statement", result: statementResult([]) },
        });
      },
    });
    await client.query("select 1", [], {
      requestedProjectId: 999,
      runtimeIdentity: "nrf-forged",
      containerId: "forged-container",
    });
    expect(captured).not.toHaveProperty("requestedProjectId");
    expect(captured).not.toHaveProperty("runtimeIdentity");
    expect(captured).not.toHaveProperty("containerId");
  });

  it("maps broker and protocol errors into stable sanitized categories", async () => {
    process.env.NABUFLOW_RUNTIME_MODE = "cloudflare-capability-v1";
    const sdk = await loadVendoredSdk();
    const cases = [
      ["database_invalid_query", 400, false, "invalid_query"],
      ["database_conflict", 409, false, "conflict"],
      ["database_timeout", 504, true, "timeout"],
      ["capability_policy_rejected", 403, false, "policy_rejected"],
      ["database_unavailable", 503, true, "unavailable"],
      ["provider-secret-detail", 500, false, "internal"],
    ] as const;
    for (const [providerCode, status, retryable, expected] of cases) {
      const client = sdk.createNabuFlowDatabase({
        fetch: async () =>
          Response.json(
            {
              ok: false,
              code: providerCode,
              message: "provider hostname and credential detail must not escape",
              retryable,
              requestId: "sdk-error-request-0001",
            },
            { status },
          ),
      });
      const error = await client.query("select 1").catch((caught: unknown) => caught);
      expect(error).toMatchObject({ code: expected, retryable });
      expect(String((error as Error).message)).not.toMatch(/provider|hostname|credential|detail/iu);
    }
  });

  it("maps malformed responses, timeouts, cancellation, and policy bounds consistently", async () => {
    process.env.NABUFLOW_RUNTIME_MODE = "cloudflare-capability-v1";
    const sdk = await loadVendoredSdk();
    const malformed = sdk.createNabuFlowDatabase({
      fetch: async () => Response.json({ ok: true, rows: [] }),
    });
    await expect(malformed.query("select 1")).rejects.toMatchObject({ code: "internal" });

    const timeout = sdk.createNabuFlowDatabase({
      fetch: async (_input: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(new DOMException("", "AbortError")));
        }),
    });
    await expect(timeout.query("select 1", [], { timeoutMs: 5 })).rejects.toMatchObject({
      code: "timeout",
      retryable: true,
    });

    const cancelledFetch = vi.fn();
    const cancelled = sdk.createNabuFlowDatabase({ fetch: cancelledFetch });
    const controller = new AbortController();
    controller.abort();
    await expect(
      cancelled.query("select 1", [], { signal: controller.signal }),
    ).rejects.toMatchObject({ code: "cancelled" });
    expect(cancelledFetch).not.toHaveBeenCalled();
    await expect(cancelled.query("select 1", [], { timeoutMs: 30_001 })).rejects.toMatchObject({
      code: "policy_rejected",
    });
    await expect(cancelled.query("select $1", [{ invalid: true }])).rejects.toMatchObject({
      code: "invalid_query",
    });
  });

  it("provides a parameter-preserving Drizzle proxy callback", async () => {
    process.env.NABUFLOW_RUNTIME_MODE = "fly-direct-v1";
    process.env.DATABASE_URL = "postgresql://legacy-fake.local/app";
    const sdk = await loadVendoredSdk();
    const query = vi.fn(async () => statementResult([{ id: 7, value: "seven" }]));
    const client = sdk.createNabuFlowDatabase({
      directDriverFactory: () => ({ query, atomicBatch: vi.fn() }),
    });
    const proxy = sdk.createDrizzleProxyAdapter(client);
    expect(await proxy("select * from items where id = $1", [7], "all")).toEqual({
      rows: [{ id: 7, value: "seven" }],
    });
    expect(query).toHaveBeenCalledWith("select * from items where id = $1", [7], {
      signal: expect.any(AbortSignal),
    });
    expect(await proxy("select * from items where id = $1", [7], "values")).toEqual({
      rows: [[7, "seven"]],
    });
  });

  it("runs the same application module with equivalent direct and capability CRUD semantics", async () => {
    const application = async (client: ReturnType<LoadedSdk["createNabuFlowDatabase"]>) => {
      await client.query("insert item", [1, "one"]);
      const selected = await client.query("select item", [1]);
      const batch = await client.batch([
        { sql: "update item", params: ["two", 1] },
        { sql: "select item", params: [1] },
      ]);
      return { selected: selected.rows, updated: batch[1]?.rows };
    };
    const execute = (sql: string, params: unknown[]) =>
      sql === "select item"
        ? statementResult([{ id: params[0], value: "one" }])
        : sql === "update item"
          ? statementResult([{ id: params[1], value: params[0] }], "UPDATE")
          : statementResult([], "INSERT");

    process.env.NABUFLOW_RUNTIME_MODE = "fly-direct-v1";
    process.env.DATABASE_URL = "postgresql://legacy-fake.local/app";
    const directSdk = await loadVendoredSdk();
    const direct = directSdk.createNabuFlowDatabase({
      directDriverFactory: () => ({
        query: async (sql: string, params: unknown[]) => execute(sql, params),
        atomicBatch: async (statements: Array<{ sql: string; params: unknown[] }>) =>
          statements.map((statement) => execute(statement.sql, statement.params)),
      }),
    });
    const directResult = await application(direct);

    process.env.NABUFLOW_RUNTIME_MODE = "cloudflare-capability-v1";
    const capabilitySdk = await loadVendoredSdk();
    const capability = capabilitySdk.createNabuFlowDatabase({
      fetch: async (_input: string, init: RequestInit) => {
        const intent = runtimeDatabaseCapabilityIntentSchema.parse(JSON.parse(String(init.body)));
        const result =
          intent.input.kind === "statement"
            ? { kind: "statement", result: execute(intent.input.sql, intent.input.params) }
            : {
                kind: "atomic-batch",
                results: intent.input.statements.map((statement) =>
                  execute(statement.sql, statement.params),
                ),
              };
        return Response.json({
          ok: true,
          capability: intent.capability,
          requestId: intent.requestId,
          runtimeIdentity: "nrf-aaaaaaaaaaaaaaaa-p42-preview-primary",
          actedBy: "database-broker",
          result,
        });
      },
    });
    const capabilityResult = await application(capability);
    expect(capabilityResult).toEqual(directResult);
  });
});
