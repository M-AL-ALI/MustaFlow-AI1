import { beforeEach, describe, expect, it, vi } from "vitest";
import { createEncryptionService } from "../encryption";

const mocks = vi.hoisted(() => {
  process.env.DATABASE_URL = "postgresql://test:test@127.0.0.1:1/test";
  process.env.ENCRYPTION_KEY = Buffer.alloc(32, 23).toString("base64");
  return {
    rows: [] as Array<Record<string, unknown>>,
    fetch: vi.fn(),
    updateSet: vi.fn(),
  };
});

vi.mock("@workspace/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@workspace/db")>();
  return {
    ...actual,
    db: {
      select: () => ({ from: () => ({ where: async () => mocks.rows }) }),
      update: () => ({
        set: (value: unknown) => {
          mocks.updateSet(value);
          return { where: async () => undefined };
        },
      }),
    },
  };
});

vi.mock("../logger", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

describe("MCP encrypted auth header invocation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("fetch", mocks.fetch);
  });

  it("decrypts the stored header only while assembling list and call requests", async () => {
    const plaintextHeader = "Bearer test-integration-header";
    const storedHeader = createEncryptionService(Buffer.alloc(32, 23).toString("base64")).encrypt(
      plaintextHeader,
    );
    mocks.rows = [
      {
        id: 41,
        name: "Weather",
        description: null,
        endpoint: "https://203.0.113.1/mcp",
        authHeader: storedHeader,
        enabled: true,
        cachedTools: null,
        cachedAt: null,
      },
    ];
    mocks.fetch
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            result: {
              tools: [
                {
                  name: "forecast",
                  description: "Forecast",
                  inputSchema: { type: "object", properties: {} },
                },
              ],
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ result: { temperature: 72 } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );

    const { callMcpTool, discoverMcpTools } = await import("../mcp");
    const tools = await discoverMcpTools();
    expect(tools).toHaveLength(1);
    expect(tools[0]!.storedAuthHeader).toBe(storedHeader);
    expect(tools[0]!.storedAuthHeader).not.toContain(plaintextHeader);

    const result = await callMcpTool(tools[0]!, { city: "Portland" });
    expect(result).toEqual({ ok: true, result: { temperature: 72 } });
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
    for (const [, init] of mocks.fetch.mock.calls) {
      expect((init as RequestInit).headers).toMatchObject({ authorization: plaintextHeader });
    }
  });
});
