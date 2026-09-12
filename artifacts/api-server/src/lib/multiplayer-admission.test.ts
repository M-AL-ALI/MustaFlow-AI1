import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { parseMultiplayerProjectId, runMultiplayerAdmission } from "./multiplayer-admission";

// Pure identity and task-lifecycle controls: no database, network, or shared document.
describe("multiplayer project identity domain", () => {
  it.each([
    ["1", 1],
    ["61", 61],
    ["00061", 61],
    ["2147483647", 2147483647],
  ])("accepts decimal project identity %s", (raw, expected) => {
    expect(parseMultiplayerProjectId(raw)).toBe(expected);
  });
  it.each([
    undefined,
    null,
    61,
    "",
    "0",
    "000",
    "-1",
    "+1",
    "1.0",
    "1e2",
    " 61",
    "61 ",
    "61x",
    "2147483648",
    "9007199254740992",
    "9".repeat(400),
  ])("rejects invalid project identity %j", (raw) => {
    expect(parseMultiplayerProjectId(raw)).toBeNull();
  });
});

describe("owned asynchronous admission", () => {
  it("preserves successful admission without invoking failure", async () => {
    const admit = vi.fn(async () => {});
    const fail = vi.fn();
    await expect(runMultiplayerAdmission(admit, fail)).resolves.toBeUndefined();
    expect(admit).toHaveBeenCalledOnce();
    expect(fail).not.toHaveBeenCalled();
  });
  it.each(["throw", "reject"])("contains an admission %s", async (kind) => {
    const admit = vi.fn(() => {
      if (kind === "throw") throw new Error("dependency unavailable");
      return Promise.reject(new Error("dependency unavailable"));
    });
    const fail = vi.fn();
    await expect(runMultiplayerAdmission(admit, fail)).resolves.toBeUndefined();
    expect(fail).toHaveBeenCalledOnce();
  });
  it.each(["throw", "reject"])("contains a failure callback %s too", async (kind) => {
    const fail = vi.fn(() => {
      if (kind === "throw") throw new Error("cleanup unavailable");
      return Promise.reject(new Error("cleanup unavailable"));
    });
    await expect(
      runMultiplayerAdmission(() => Promise.reject(new Error("unavailable")), fail),
    ).resolves.toBeUndefined();
    expect(fail).toHaveBeenCalledOnce();
  });
  it("owns rejection even when an EventEmitter ignores the listener result", async () => {
    const emitter = new EventEmitter();
    let finish!: () => void;
    const observed = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const fail = vi.fn(() => {
      finish();
    });
    emitter.on("admission", () =>
      runMultiplayerAdmission(() => Promise.reject(new Error("dependency unavailable")), fail),
    );
    expect(emitter.emit("admission")).toBe(true);
    await observed;
    expect(fail).toHaveBeenCalledOnce();
    emitter.removeAllListeners();
  });
});
