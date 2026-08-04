import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
  insertValues: vi.fn(async () => undefined),
}));

vi.mock("@workspace/db", () => ({
  projectsTable: {},
  containerLogsTable: {},
  db: {
    insert: vi.fn(() => ({ values: mocks.insertValues })),
  },
}));

vi.mock("./logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

describe("Fly tenant runtime service port payload", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv("FLY_API_TOKEN", "test-token");
    vi.stubEnv("FLY_APP_NAME", "test-runtime-app");
    mocks.fetch.mockReset();
    vi.stubGlobal("fetch", mocks.fetch);
  });

  it("preserves the legacy stack port when no explicit project port exists", async () => {
    mocks.fetch.mockResolvedValue(
      new Response(JSON.stringify({ id: "runtime-default" }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const { createContainer } = await import("./container");

    const result = await createContainer(11, "python-flask", {});
    const request = mocks.fetch.mock.calls[0]?.[1] as RequestInit;
    const payload = JSON.parse(String(request.body)) as {
      config: { env: { PORT: string }; services: Array<{ internal_port: number }> };
    };

    expect(payload.config.env.PORT).toBe("5000");
    expect(payload.config.services[0]?.internal_port).toBe(5000);
    expect(result).toMatchObject({ servicePort: 5000 });
  });

  it("uses an explicit project port for both env and service routing", async () => {
    mocks.fetch.mockResolvedValue(
      new Response(JSON.stringify({ id: "runtime-explicit" }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const { createContainer } = await import("./container");

    const result = await createContainer(12, "node-api", {}, { servicePort: 4321 });
    const request = mocks.fetch.mock.calls[0]?.[1] as RequestInit;
    const payload = JSON.parse(String(request.body)) as {
      config: { env: { PORT: string }; services: Array<{ internal_port: number }> };
    };

    expect(payload.config.env.PORT).toBe("4321");
    expect(payload.config.services[0]?.internal_port).toBe(4321);
    expect(result).toMatchObject({ servicePort: 4321 });
  });
});
