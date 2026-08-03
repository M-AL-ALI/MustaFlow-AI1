/**
 * Regression tests for the terminal WebSocket authentication guard.
 *
 * Three cases must hold:
 *   1. Unauthenticated (userId === null) → 4001 Unauthorized, no container access.
 *   2. Authenticated non-owner            → 4003 Forbidden,      no container access.
 *   3. Authenticated owner                → connection proceeds,  execInContainer is reachable.
 *
 * These tests FAIL without the null-guard added after the auth try/catch and
 * PASS once that guard is present.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { IncomingMessage } from "node:http";

// ── Hoisted mocks ────────────────────────────────────────────────────────────
const { mockGetAuth, mockDbWhere, mockExecInContainer } = vi.hoisted(() => ({
  mockGetAuth: vi.fn(),
  mockDbWhere: vi.fn(),
  mockExecInContainer: vi.fn(),
}));

vi.mock("@clerk/express", () => ({
  getAuth: mockGetAuth,
}));

vi.mock("@workspace/db", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: mockDbWhere,
      }),
    }),
  },
  projectsTable: {},
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn(),
  and: vi.fn(),
  isNull: vi.fn(),
}));

vi.mock("../container", () => ({
  execInContainer: mockExecInContainer,
}));

vi.mock("../logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// ── Import under test (after mocks) ──────────────────────────────────────────
import { createTerminalServer } from "../terminal";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeReq(url: string): IncomingMessage {
  return { url, headers: {} } as unknown as IncomingMessage;
}

/**
 * Returns a minimal mock WebSocket plus a promise that resolves with the
 * [code, reason] pair when ws.close() is first called.
 */
function makeMockWs() {
  let resolveClose!: (args: [number, string]) => void;
  const closedPromise = new Promise<[number, string]>((resolve) => {
    resolveClose = resolve;
  });

  const messageHandlers: Array<(data: Buffer) => void> = [];

  const ws = {
    readyState: 1, // WebSocket.OPEN
    send: vi.fn(),
    close: vi.fn().mockImplementation((code: number, reason: string) => {
      resolveClose([code, reason]);
    }),
    on: vi.fn().mockImplementation((event: string, handler: unknown) => {
      if (event === "message") {
        messageHandlers.push(handler as (data: Buffer) => void);
      }
    }),
  };

  return { ws, closedPromise, messageHandlers };
}

const RUNNING_PROJECT = {
  ownerId: "user_owner",
  containerId: "machine-abc123",
  containerStatus: "running",
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("terminal WebSocket authentication guard", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockDbWhere.mockResolvedValue([RUNNING_PROJECT]);
    mockExecInContainer.mockResolvedValue({ ok: true, output: "" });
  });

  it("rejects an unauthenticated connection with 4001 before any container access", async () => {
    mockGetAuth.mockReturnValue({ userId: null });

    const { wss } = createTerminalServer();
    const { ws, closedPromise } = makeMockWs();

    wss.emit("connection", ws, makeReq("/api/projects/42/terminal"));

    const [code, reason] = await closedPromise;

    expect(code).toBe(4001);
    expect(reason).toBe("Unauthorized");
    // The container must never have been touched
    expect(mockExecInContainer).not.toHaveBeenCalled();
  });

  it("rejects a non-owner authenticated connection with 4003 before any container access", async () => {
    mockGetAuth.mockReturnValue({ userId: "user_intruder" });
    // Project is owned by someone else
    mockDbWhere.mockResolvedValue([{ ...RUNNING_PROJECT, ownerId: "user_owner" }]);

    const { wss } = createTerminalServer();
    const { ws, closedPromise } = makeMockWs();

    wss.emit("connection", ws, makeReq("/api/projects/42/terminal"));

    const [code, reason] = await closedPromise;

    expect(code).toBe(4003);
    expect(reason).toBe("Forbidden");
    expect(mockExecInContainer).not.toHaveBeenCalled();
  });

  it("allows the owner through and wires up the message handler for command execution", async () => {
    mockGetAuth.mockReturnValue({ userId: "user_owner" });
    mockDbWhere.mockResolvedValue([RUNNING_PROJECT]);
    mockExecInContainer.mockResolvedValue({ ok: true, output: "hello\n" });

    const { wss } = createTerminalServer();
    const { ws, closedPromise: _, messageHandlers } = makeMockWs();
    // Override close so a spurious early close turns into a test failure
    ws.close = vi.fn();

    wss.emit("connection", ws, makeReq("/api/projects/42/terminal"));

    // Wait for the async DB lookup to settle and message handler to be registered
    await vi.waitFor(() => expect(ws.on).toHaveBeenCalledWith("message", expect.any(Function)), {
      timeout: 2000,
    });

    // Not closed with auth errors
    expect(ws.close).not.toHaveBeenCalledWith(4001, expect.anything());
    expect(ws.close).not.toHaveBeenCalledWith(4003, expect.anything());

    // Simulate typing "ls" + Enter to verify execInContainer is reachable
    const [msgHandler] = messageHandlers;
    expect(msgHandler).toBeDefined();
    await msgHandler!(Buffer.from("l"));
    await msgHandler!(Buffer.from("s"));
    await msgHandler!(Buffer.from("\r")); // Enter — triggers execution

    expect(mockExecInContainer).toHaveBeenCalledWith(
      RUNNING_PROJECT.containerId,
      ["/bin/sh", "-c", "ls"],
      42,
    );
  });
});
