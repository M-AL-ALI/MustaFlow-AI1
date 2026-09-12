import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMultiplayerWriteGate, multiplayerSyncAccess } from "./multiplayer-write-access";

const mocks = vi.hoisted(() => ({ checkAccess: vi.fn() }));
vi.mock("./auth", () => ({ checkProjectAccess: mocks.checkAccess }));

beforeEach(() => {
  vi.resetAllMocks();
  mocks.checkAccess.mockResolvedValue("granted");
});

// These are isolated permission/dispatch-metadata tests. They do not create a
// socket, encode a collaboration frame, or read/write a shared Yjs document.
describe("multiplayer sync permission classification", () => {
  it("keeps the initial state-vector request read-only", () => {
    expect(multiplayerSyncAccess(0)).toBe("read");
  });
  it.each([1, 2])("requires write access for mutation-bearing sync subtype %s", (kind) => {
    expect(multiplayerSyncAccess(kind)).toBe("write");
  });
  it.each([-1, 3, 99, 0.5, NaN, Infinity])("rejects unknown sync subtype %s", (kind) => {
    expect(multiplayerSyncAccess(kind)).toBe("invalid");
  });
});

describe("fresh collaboration write authorization", () => {
  function input() {
    const context = { userId: "collaborator", projectId: 61, isActive: vi.fn(() => true) };
    return { ...context, apply: vi.fn(), gate: createMultiplayerWriteGate(context) };
  }
  it.each(["owner", "editor", "organization-member"])(
    "retains authorized %s edits through the canonical member policy",
    async (userId) => {
      const edit = input();
      edit.gate = createMultiplayerWriteGate({ ...edit, userId });
      expect(await edit.gate(edit.apply)).toBe("applied");
      expect(mocks.checkAccess).toHaveBeenCalledWith(userId, 61, "member");
      expect(edit.apply).toHaveBeenCalledOnce();
    },
  );
  it.each(["insufficient_role", "not_member", "not_found", undefined])(
    "does not invoke an edit callback for access decision %s",
    async (decision) => {
      mocks.checkAccess.mockResolvedValue(decision);
      const edit = input();
      expect(await edit.gate(edit.apply)).toBe("read_only");
      expect(edit.apply).not.toHaveBeenCalled();
    },
  );
  it("fails closed on an access lookup error", async () => {
    mocks.checkAccess.mockRejectedValue(new Error("lookup unavailable"));
    const edit = input();
    expect(await edit.gate(edit.apply)).toBe("unavailable");
    expect(edit.apply).not.toHaveBeenCalled();
  });
  it("does not reuse a former editor grant after downgrade", async () => {
    const edit = input();
    mocks.checkAccess.mockResolvedValueOnce("granted").mockResolvedValueOnce("insufficient_role");
    expect(await edit.gate(edit.apply)).toBe("applied");
    expect(await edit.gate(edit.apply)).toBe("read_only");
    expect(mocks.checkAccess).toHaveBeenCalledTimes(2);
    expect(edit.apply).toHaveBeenCalledOnce();
  });
  it("allows a later fresh grant without permanently denying a viewer's connection", async () => {
    const edit = input();
    mocks.checkAccess.mockResolvedValueOnce("insufficient_role").mockResolvedValueOnce("granted");
    expect(await edit.gate(edit.apply)).toBe("read_only");
    expect(await edit.gate(edit.apply)).toBe("applied");
    expect(edit.apply).toHaveBeenCalledOnce();
  });
  it.each(["insufficient_role", "lookup_failure"])(
    "invalidates an older pending grant when a newer check reports %s",
    async (denial) => {
      let finish!: (value: string) => void;
      mocks.checkAccess.mockReturnValueOnce(
        new Promise<string>((resolve) => {
          finish = resolve;
        }),
      );
      if (denial === "lookup_failure")
        mocks.checkAccess.mockRejectedValueOnce(new Error("unavailable"));
      else mocks.checkAccess.mockResolvedValueOnce(denial);
      const edit = input();
      const older = edit.gate(edit.apply);
      expect(await edit.gate(edit.apply)).toBe(
        denial === "lookup_failure" ? "unavailable" : "read_only",
      );
      finish("granted");
      expect(await older).toBe("read_only");
      expect(edit.apply).not.toHaveBeenCalled();
      mocks.checkAccess.mockResolvedValueOnce("granted");
      expect(await edit.gate(edit.apply)).toBe("applied");
      expect(edit.apply).toHaveBeenCalledOnce();
    },
  );
  it("does not query or apply after the connection has closed", async () => {
    const edit = input();
    edit.isActive.mockReturnValue(false);
    expect(await edit.gate(edit.apply)).toBe("closed");
    expect(mocks.checkAccess).not.toHaveBeenCalled();
    expect(edit.apply).not.toHaveBeenCalled();
  });
  it.each(["granted", "rejected"])("drops a pending %s lookup after disconnect", async (result) => {
    let finish!: (value: string) => void;
    let reject!: (error: Error) => void;
    mocks.checkAccess.mockReturnValue(
      new Promise<string>((resolve, fail) => {
        finish = resolve;
        reject = fail;
      }),
    );
    const edit = input();
    const pending = edit.gate(edit.apply);
    edit.isActive.mockReturnValue(false);
    if (result === "granted") finish("granted");
    else reject(new Error("lookup unavailable"));
    expect(await pending).toBe("closed");
    expect(edit.apply).not.toHaveBeenCalled();
  });
});
