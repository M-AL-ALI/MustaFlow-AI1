import { IncomingMessage } from "node:http";
import { Socket } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMultiplayerServer } from "./multiplayer";

const mocks = vi.hoisted(() => ({
  verifyRequest: vi.fn(),
  selectProject: vi.fn(),
  checkAccess: vi.fn(),
  supportGrant: vi.fn(),
  profile: vi.fn(),
  warn: vi.fn(),
  on: vi.fn(),
  emit: vi.fn(),
  upgrade: vi.fn(),
}));
vi.mock("@clerk/express", () => ({ clerkClient: { authenticateRequest: mocks.verifyRequest } }));
vi.mock("@workspace/db", () => ({
  db: { select: () => ({ from: () => ({ where: mocks.selectProject }) }) },
  projectsTable: {
    id: "id",
    deletedAt: "deleted_at",
    ownerId: "owner_id",
    multiplayerEnabled: "multiplayer_enabled",
  },
}));
vi.mock("./auth", () => ({ checkProjectAccess: mocks.checkAccess }));
vi.mock("./clerk-users", () => ({ getSharedAccountProfile: mocks.profile }));
vi.mock("./support-access", () => ({ findLiveSupportGrant: mocks.supportGrant }));
vi.mock("./support-ticket-workflow", () => ({ formatSupportTicketNumber: () => "NF-000001" }));
vi.mock("./logger", () => ({ logger: { warn: mocks.warn } }));
vi.mock("ws", () => ({
  WebSocket: { OPEN: 1 },
  WebSocketServer: class {
    on(...args: unknown[]) {
      return mocks.on(...args);
    }
    emit(...args: unknown[]) {
      return mocks.emit(...args);
    }
    handleUpgrade(...args: unknown[]) {
      return mocks.upgrade(...args);
    }
  },
}));

function webSocket() {
  const handlers = new Map<string, (...args: unknown[]) => void>();
  const ws = {
    readyState: 1,
    send: vi.fn(),
    ping: vi.fn(),
    fail: vi.fn(() => handlers.get("error")?.(new Error("Socket failed during admission"))),
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      handlers.set(event, handler);
      return ws;
    }),
    close: vi.fn((_code?: number, _reason?: string) => {
      ws.readyState = 3;
      handlers.get("close")?.();
    }),
    terminate: vi.fn(() => ws.close()),
  };
  return ws;
}

type TestWebSocket = ReturnType<typeof webSocket>;
let connection: (ws: TestWebSocket, req: IncomingMessage) => Promise<void>;
let connectionResult: Promise<void> | undefined;
let currentWs: TestWebSocket;

function request(): IncomingMessage {
  const req = new IncomingMessage(new Socket());
  req.method = "GET";
  req.url = "/api/projects/61/multiplayer?location=Preview";
  req.headers = {
    host: "app.example.test",
    origin: "https://app.example.test",
    "x-forwarded-proto": "https",
    cookie: "__session=test-session-cookie",
  };
  return req;
}

function verified(userId: string, legacyUserId?: string) {
  return {
    status: "signed-in",
    isAuthenticated: true,
    tokenType: "session_token",
    headers: new Headers(),
    toAuth: () => ({ userId, sessionClaims: { userId: legacyUserId } }),
  };
}

function frames() {
  return currentWs.send.mock.calls
    .filter(([value]) => typeof value === "string")
    .map(([value]) => JSON.parse(value as string));
}

async function upgrade(req = request(), waitForAdmission = true) {
  const listeners = new Map<string, () => void>();
  const transport = {
    destroyed: false,
    writable: true,
    on: vi.fn((event: string, listener: () => void) => listeners.set(event, listener)),
    once: vi.fn((event: string, listener: () => void) => listeners.set(event, listener)),
    removeListener: vi.fn((event: string, listener: () => void) => {
      if (listeners.get(event) === listener) listeners.delete(event);
    }),
    end: vi.fn((_response: string, complete: () => void) => complete()),
    destroy: vi.fn(() => {
      transport.destroyed = true;
      listeners.get("close")?.();
    }),
  };
  const server = createMultiplayerServer();
  server.handleUpgrade(req, transport as unknown as Socket, Buffer.alloc(0));
  await vi.advanceTimersByTimeAsync(0);
  if (waitForAdmission && connectionResult) await connectionResult;
  return { transport, server };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.resetAllMocks();
  connectionResult = undefined;
  currentWs = webSocket();
  mocks.on.mockImplementation((event, handler) => {
    if (event === "connection") connection = handler;
  });
  mocks.emit.mockImplementation((event, ws, req) => {
    if (event === "connection") connectionResult = connection(ws, req);
    return true;
  });
  mocks.upgrade.mockImplementation((req, _transport, _head, callback) => callback(currentWs));
  mocks.verifyRequest.mockResolvedValue(verified("owner-61"));
  mocks.selectProject.mockResolvedValue([{ ownerId: "owner-61", multiplayerEnabled: false }]);
  mocks.checkAccess.mockResolvedValue("granted");
  mocks.supportGrant.mockResolvedValue(null);
  mocks.profile.mockResolvedValue({ displayName: "Project member", imageUrl: "/member.png" });
});
afterEach(() => {
  currentWs.close();
  vi.useRealTimers();
});

describe("collaboration upgrade authorization", () => {
  it.each(["0", "2147483648", "9007199254740992", "9".repeat(400)])(
    "rejects project identity %s before authentication, upgrade, or lookup",
    async (id) => {
      const req = request();
      req.url = "/api/projects/" + id + "/multiplayer";
      const { transport } = await upgrade(req);
      expect(mocks.verifyRequest).not.toHaveBeenCalled();
      expect(mocks.upgrade).not.toHaveBeenCalled();
      expect(mocks.selectProject).not.toHaveBeenCalled();
      expect(mocks.checkAccess).not.toHaveBeenCalled();
      expect(transport.end).toHaveBeenCalledWith(
        "HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
        expect.any(Function),
      );
    },
  );

  it("retains leading-zero project IDs and binds the validated scope before async verification", async () => {
    const req = request();
    req.url = "/api/projects/00061/multiplayer?location=Preview";
    let finish!: (value: ReturnType<typeof verified>) => void;
    mocks.verifyRequest.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    await upgrade(req, false);
    req.url = "/api/projects/62/multiplayer?location=Preview";
    finish(verified("owner-61"));
    await vi.advanceTimersByTimeAsync(0);
    await connectionResult;
    expect(mocks.checkAccess).toHaveBeenCalledWith("owner-61", 61, "viewer");
    expect(mocks.checkAccess).not.toHaveBeenCalledWith("owner-61", 62, "viewer");
  });

  it.each(["project", "access", "support", "profile"])(
    "contains a rejected %s lookup in the actual registered admission listener",
    async (phase) => {
      const lookup =
        phase === "project"
          ? mocks.selectProject
          : phase === "access"
            ? mocks.checkAccess
            : phase === "support"
              ? mocks.supportGrant
              : mocks.profile;
      lookup.mockRejectedValueOnce(new Error("private dependency detail"));
      const timersBefore = vi.getTimerCount();
      await upgrade();
      await expect(connectionResult).resolves.toBeUndefined();
      expect(frames()).toEqual([
        {
          type: "error",
          code: "presence_temporarily_unavailable",
          message: "Collaboration could not connect. Retrying shortly.",
        },
      ]);
      expect(currentWs.close).toHaveBeenCalledWith(4413, "Collaboration temporarily unavailable");
      expect(vi.getTimerCount()).toBe(timersBefore);
      expect(mocks.warn).toHaveBeenCalledWith("multiplayer: connection admission failed");
    },
  );

  it.each(["close", "error"] as const)(
    "settles a later lookup rejection after %s without new sends or timers",
    async (signal) => {
      let reject!: (error: Error) => void;
      mocks.profile.mockReturnValue(
        new Promise((_resolve, fail) => {
          reject = fail;
        }),
      );
      const timersBefore = vi.getTimerCount();
      await upgrade(request(), false);
      if (signal === "close") currentWs.close();
      else currentWs.fail();
      const sends = currentWs.send.mock.calls.length;
      const closes = currentWs.close.mock.calls.length;
      reject(new Error("private dependency detail"));
      await expect(connectionResult).resolves.toBeUndefined();
      expect(currentWs.send).toHaveBeenCalledTimes(sends);
      expect(currentWs.close).toHaveBeenCalledTimes(closes);
      expect(vi.getTimerCount()).toBe(timersBefore);
    },
  );

  it("releases a partially registered peer when later listener registration fails", async () => {
    const originalOn = currentWs.on.getMockImplementation()!;
    currentWs.on.mockImplementation((event, handler) => {
      if (event === "message") throw new Error("listener unavailable");
      return originalOn(event, handler);
    });
    const timersBefore = vi.getTimerCount();
    await upgrade();
    await expect(connectionResult).resolves.toBeUndefined();
    expect(currentWs.close).toHaveBeenCalledWith(4413, "Collaboration temporarily unavailable");
    expect(vi.getTimerCount()).toBe(timersBefore);
    currentWs = webSocket();
    await upgrade();
    expect(frames().find((frame) => frame.type === "roster")?.peers).toHaveLength(1);
  });

  it.each(["logger", "close"])("settles the failure even when %s throws", async (component) => {
    mocks.selectProject.mockRejectedValueOnce(new Error("unavailable"));
    if (component === "logger")
      mocks.warn.mockImplementationOnce(() => {
        throw new Error("logger unavailable");
      });
    else
      currentWs.close.mockImplementationOnce(() => {
        throw new Error("close unavailable");
      });
    await upgrade();
    await expect(connectionResult).resolves.toBeUndefined();
    expect(currentWs.readyState).toBe(3);
    if (component === "close") expect(currentWs.terminate).toHaveBeenCalledOnce();
  });

  it("admits the verified owner, including presence with live editing disabled", async () => {
    await upgrade();
    expect(mocks.upgrade).toHaveBeenCalledOnce();
    expect(mocks.checkAccess).toHaveBeenCalledWith("owner-61", 61, "viewer");
    expect(frames()).toContainEqual(
      expect.objectContaining({
        type: "hello",
        you: expect.objectContaining({ kind: "owner" }),
      }),
    );
  });

  it("uses the verified REST-compatible legacy owner identity", async () => {
    mocks.verifyRequest.mockResolvedValue(verified("new-clerk-subject", "owner-61"));
    await upgrade();
    expect(mocks.checkAccess).toHaveBeenCalledWith("owner-61", 61, "viewer");
    expect(frames()).toContainEqual(
      expect.objectContaining({
        type: "hello",
        you: expect.objectContaining({ kind: "owner" }),
      }),
    );
  });

  it("admits an authorized collaborator without promoting them to owner", async () => {
    mocks.verifyRequest.mockResolvedValue(verified("collaborator-61"));
    await upgrade();
    expect(mocks.checkAccess).toHaveBeenCalledWith("collaborator-61", 61, "viewer");
    expect(frames()).toContainEqual(
      expect.objectContaining({
        type: "hello",
        you: expect.objectContaining({ kind: "teammate" }),
      }),
    );
  });

  it("rejects a verified outsider even when request fields claim the owner ID", async () => {
    mocks.verifyRequest.mockResolvedValue(verified("outsider"));
    mocks.checkAccess.mockResolvedValue("not_member");
    const req = request();
    req.url += "&userId=owner-61";
    Object.assign(req, { userId: "owner-61", auth: () => ({ userId: "owner-61" }) });
    await upgrade(req);
    expect(mocks.checkAccess).toHaveBeenCalledWith("outsider", 61, "viewer");
    expect(frames()).toEqual([{ type: "error", message: "Forbidden" }]);
    expect(currentWs.close).toHaveBeenCalledWith(4003, "Forbidden");
  });

  it("does not upgrade or look up the project for an unauthenticated request", async () => {
    mocks.verifyRequest.mockResolvedValue({ status: "signed-out", isAuthenticated: false });
    const { transport } = await upgrade();
    expect(mocks.upgrade).not.toHaveBeenCalled();
    expect(mocks.selectProject).not.toHaveBeenCalled();
    expect(mocks.checkAccess).not.toHaveBeenCalled();
    expect(transport.end).toHaveBeenCalledWith(
      "HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
      expect.any(Function),
    );
  });

  it("does not upgrade a socket that closes while authentication is pending", async () => {
    let finish!: (value: ReturnType<typeof verified>) => void;
    mocks.verifyRequest.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const { transport } = await upgrade();
    transport.destroy();
    finish(verified("owner-61"));
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.upgrade).not.toHaveBeenCalled();
    expect(mocks.selectProject).not.toHaveBeenCalled();
  });

  it("rejects a hostile origin before any verifier or project lookup", async () => {
    const req = request();
    req.headers.origin = "https://attacker.invalid";
    await upgrade(req);
    expect(mocks.verifyRequest).not.toHaveBeenCalled();
    expect(mocks.upgrade).not.toHaveBeenCalled();
    expect(mocks.selectProject).not.toHaveBeenCalled();
  });

  it("does not accept a forged direct connection event without verified upgrade admission", async () => {
    createMultiplayerServer();
    const req = request();
    Object.assign(req, { auth: () => ({ userId: "owner-61" }) });
    await connection(currentWs, req);
    expect(frames()).toEqual([{ type: "error", message: "Unauthorized" }]);
    expect(mocks.selectProject).not.toHaveBeenCalled();
  });

  describe.each(["close", "error"] as const)("cancelled admission on %s", (signal) => {
    it.each(["project", "access", "support", "profile"] as const)(
      "does not register a peer after a delayed %s lookup resolves",
      async (phase) => {
        let finish!: (value: unknown) => void;
        const delayed = new Promise<unknown>((resolve) => {
          finish = resolve;
        });
        const pendingLookup =
          phase === "project"
            ? mocks.selectProject
            : phase === "access"
              ? mocks.checkAccess
              : phase === "support"
                ? mocks.supportGrant
                : mocks.profile;
        pendingLookup.mockReturnValueOnce(delayed);
        const timersBefore = vi.getTimerCount();
        await upgrade(request(), false);
        expect(pendingLookup).toHaveBeenCalledOnce();
        const abandoned = currentWs;
        if (signal === "close") abandoned.close();
        else abandoned.fail();
        finish(
          phase === "project"
            ? [{ ownerId: "owner-61", multiplayerEnabled: false }]
            : phase === "access"
              ? "granted"
              : phase === "support"
                ? null
                : { displayName: "Project member", imageUrl: "/member.png" },
        );
        await connectionResult;
        expect(abandoned.send).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(timersBefore);
        if (phase === "project") {
          expect(mocks.checkAccess).not.toHaveBeenCalled();
          expect(mocks.supportGrant).not.toHaveBeenCalled();
          expect(mocks.profile).not.toHaveBeenCalled();
        }
        const accessChecks = mocks.checkAccess.mock.calls.length;
        const grantChecks = mocks.supportGrant.mock.calls.length;
        await vi.advanceTimersByTimeAsync(12_000);
        expect(mocks.checkAccess).toHaveBeenCalledTimes(accessChecks);
        expect(mocks.supportGrant).toHaveBeenCalledTimes(grantChecks);
        expect(abandoned.ping).not.toHaveBeenCalled();
        // A repeated close after cancellation must remain harmless.
        abandoned.close();
        abandoned.close();
        currentWs = webSocket();
        await upgrade();
        const roster = frames().find((frame) => frame.type === "roster");
        expect(roster?.peers).toHaveLength(1);
      },
    );
  });

  it("keeps teardown idempotent after a peer and its watchers have registered", async () => {
    const timersBefore = vi.getTimerCount();
    await upgrade();
    const departed = currentWs;
    departed.fail();
    departed.close();
    departed.close();
    expect(vi.getTimerCount()).toBe(timersBefore);
    const accessChecks = mocks.checkAccess.mock.calls.length;
    const grantChecks = mocks.supportGrant.mock.calls.length;
    await vi.advanceTimersByTimeAsync(12_000);
    expect(mocks.checkAccess).toHaveBeenCalledTimes(accessChecks);
    expect(mocks.supportGrant).toHaveBeenCalledTimes(grantChecks);
    expect(departed.ping).not.toHaveBeenCalled();
    currentWs = webSocket();
    await upgrade();
    const roster = frames().find((frame) => frame.type === "roster");
    expect(roster?.peers).toHaveLength(1);
  });

  it("retains the shared profile requirement", async () => {
    mocks.profile.mockResolvedValue({ displayName: "Project member", imageUrl: null });
    await upgrade();
    expect(frames()).toContainEqual(
      expect.objectContaining({ code: "presence_identity_required" }),
    );
    expect(currentWs.close).toHaveBeenCalledWith(4409, "Identity required");
  });

  it("retains periodic collaborator access revocation", async () => {
    await upgrade();
    mocks.checkAccess.mockResolvedValue("not_member");
    await vi.advanceTimersByTimeAsync(2_000);
    expect(frames()).toContainEqual({
      type: "access_removed",
      message: "Your access to this project has ended.",
    });
    expect(currentWs.close).toHaveBeenCalledWith(4403, "Project access ended");
  });

  it("retains expiration of user-approved staff access", async () => {
    mocks.verifyRequest.mockResolvedValue(verified("support-user"));
    mocks.checkAccess.mockResolvedValue("not_member");
    mocks.supportGrant.mockResolvedValue({
      id: 7,
      ticketId: 1,
      expiresAt: new Date(Date.now() + 60_000),
    });
    await upgrade();
    expect(frames()).toContainEqual(
      expect.objectContaining({
        type: "hello",
        you: expect.objectContaining({ kind: "staff" }),
      }),
    );
    mocks.supportGrant.mockResolvedValue(null);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(frames()).toContainEqual({
      type: "grant_closed",
      message: "The user's support access has ended.",
    });
    expect(currentWs.close).toHaveBeenCalledWith(4403, "Support access ended");
  });
});
