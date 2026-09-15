import { describe, expect, it } from "vitest";
import { MessageReplayCache, type MessageReplayScope } from "./message-replay-cache";

const scope: MessageReplayScope = {
  actorId: "owner-a",
  projectId: 61,
  kind: "stream",
  operation: "message",
};
const payload = {
  userMessageId: 11,
  assistantMessageId: 12,
  plan: { kind: "converse" },
  terminal: { outcome: "completed", summary: "Private synthetic reply" },
};
function complete(cache: MessageReplayCache, key = "same-key", owner = scope) {
  const request = cache.forRequest(owner);
  expect(request.set(key, { status: "in-flight", timestamp: 0 })).toBe(true);
  expect(request.set(key, { status: "done", result: payload, timestamp: 0 })).toBe(true);
  return request;
}

describe("scoped message replay cache", () => {
  it.each([{ actorId: "owner-b" }, { projectId: 62 }, { operation: "support-session:7" }])(
    "isolates a different scope %j",
    (change) => {
      const cache = new MessageReplayCache();
      complete(cache);
      const other = cache.forRequest({ ...scope, ...change });
      expect(other.get("same-key")).toBeUndefined();
      expect(other.delete("same-key")).toBe(false);
      expect(cache.forRequest(scope).get("same-key")?.result).toEqual(payload);
    },
  );

  it.each(["support-proposal:7", "support-session:7", "__proto__", 'x",61,"message"', "a\u0000b"])(
    "treats caller key %j as opaque data",
    (key) => {
      const cache = new MessageReplayCache();
      complete(cache, key);
      expect(cache.forRequest({ ...scope, actorId: "owner-b" }).get(key)).toBeUndefined();
      expect(cache.forRequest(scope).get(key)?.result).toEqual(payload);
    },
  );

  it("replays a completed response but never grants its claim to a retry", () => {
    const cache = new MessageReplayCache();
    complete(cache);
    const retry = cache.forRequest(scope);
    expect(retry.get("same-key")?.result).toEqual(payload);
    expect(retry.set("same-key", { status: "in-flight", timestamp: 0 })).toBe(false);
    expect(retry.delete("same-key")).toBe(false);
    retry.releasePending();
    expect(retry.get("same-key")?.result).toEqual(payload);
  });

  it("keeps concurrent duplicates in flight without a second claim", () => {
    const cache = new MessageReplayCache();
    const first = cache.forRequest(scope);
    const second = cache.forRequest(scope);
    expect(first.set("key", { status: "in-flight", timestamp: 0 })).toBe(true);
    expect(second.get("key")?.status).toBe("in-flight");
    expect(second.set("key", { status: "in-flight", timestamp: 0 })).toBe(false);
    expect(second.delete("key")).toBe(false);
    first.releasePending();
    expect(second.set("key", { status: "in-flight", timestamp: 0 })).toBe(true);
  });

  it("uses one in-flight execution claim across response formats", () => {
    const cache = new MessageReplayCache();
    const stream = cache.forRequest(scope);
    const regular = cache.forRequest({ ...scope, kind: "regular" });
    expect(stream.set("key", { status: "in-flight", timestamp: 0 })).toBe(true);
    expect(regular.get("key")?.status).toBe("in-flight");
    expect(regular.set("key", { status: "in-flight", timestamp: 0 })).toBe(false);
    regular.releasePending();
    expect(stream.get("key")?.status).toBe("in-flight");
  });

  it("blocks completed cross-format execution without exposing or erasing the payload", () => {
    const cache = new MessageReplayCache();
    complete(cache);
    const regular = cache.forRequest({ ...scope, kind: "regular" });
    expect(regular.get("same-key")).toEqual({
      status: "done-other-format",
      timestamp: expect.any(Number),
    });
    expect(regular.set("same-key", { status: "in-flight", timestamp: 0 })).toBe(false);
    expect(regular.delete("same-key")).toBe(false);
    expect(cache.forRequest(scope).get("same-key")?.result).toEqual(payload);
  });

  it("allows explicit streaming fallback to hand the claim to the regular route", () => {
    const cache = new MessageReplayCache();
    const stream = cache.forRequest(scope);
    stream.set("key", { status: "in-flight", timestamp: 0 });
    expect(stream.delete("key")).toBe(true);
    const regular = cache.forRequest({ ...scope, kind: "regular" });
    expect(regular.set("key", { status: "in-flight", timestamp: 0 })).toBe(true);
    stream.releasePending();
    expect(regular.get("key")?.status).toBe("in-flight");
  });

  it("expires completed entries on lookup without waiting for the sweep", () => {
    let now = 0;
    const cache = new MessageReplayCache(() => now, 100);
    complete(cache);
    now = 99;
    expect(cache.forRequest(scope).get("same-key")?.status).toBe("done");
    now = 100;
    expect(cache.forRequest(scope).get("same-key")).toBeUndefined();
  });

  it("keeps a long-running claim and starts reply TTL at successful completion", () => {
    let now = 0;
    const cache = new MessageReplayCache(() => now, 100);
    const first = cache.forRequest(scope);
    first.set("key", { status: "in-flight", timestamp: 0 });
    now = 1000;
    cache.prune();
    const duplicate = cache.forRequest({ ...scope, kind: "regular" });
    expect(duplicate.get("key")?.status).toBe("in-flight");
    expect(duplicate.set("key", { status: "in-flight", timestamp: 0 })).toBe(false);
    expect(first.set("key", { status: "done", result: payload, timestamp: 0 })).toBe(true);
    now = 1099;
    expect(cache.forRequest(scope).get("key")?.result).toEqual(payload);
    now = 1100;
    expect(cache.forRequest(scope).get("key")).toBeUndefined();
  });

  it.each(["complete", "delete", "release"])(
    "fences stale request %s after a failed claim is released and replaced",
    (action) => {
      const cache = new MessageReplayCache();
      const stale = cache.forRequest(scope);
      stale.set("key", { status: "in-flight", timestamp: 0 });
      stale.releasePending();
      const replacement = cache.forRequest(scope);
      replacement.set("key", { status: "in-flight", timestamp: 0 });
      if (action === "complete")
        expect(stale.set("key", { status: "done", result: payload, timestamp: 0 })).toBe(false);
      if (action === "delete") expect(stale.delete("key")).toBe(false);
      if (action === "release") stale.releasePending();
      expect(replacement.get("key")?.status).toBe("in-flight");
      expect(replacement.set("key", { status: "done", result: payload, timestamp: 0 })).toBe(true);
    },
  );

  it("preserves a completed reply when its original delivery fails", () => {
    const cache = new MessageReplayCache();
    const owner = complete(cache);
    expect(owner.delete("same-key")).toBe(false);
    owner.releasePending();
    expect(cache.forRequest(scope).get("same-key")?.result).toEqual(payload);
  });

  it("strips foreign SSE fields and keeps the legitimate terminal payload", () => {
    const cache = new MessageReplayCache();
    const request = cache.forRequest(scope);
    request.set("key", { status: "in-flight", timestamp: 0 });
    request.set("key", {
      status: "done",
      result: { ...payload, type: "error", userMessage: { content: "not an SSE field" } },
      timestamp: 0,
    });
    expect(request.get("key")?.result).toEqual(payload);
  });

  it.each([undefined, {}, { userMessageId: "11", assistantMessageId: 12, plan: {} }])(
    "does not cache an invalid completion %j",
    (result) => {
      const cache = new MessageReplayCache();
      const request = cache.forRequest(scope);
      request.set("key", { status: "in-flight", timestamp: 0 });
      expect(request.set("key", { status: "done", result, timestamp: 0 })).toBe(false);
      expect(request.get("key")).toBeUndefined();
    },
  );

  it.each([undefined, ""])("does not cache for missing actor %j", (actorId) => {
    const cache = new MessageReplayCache();
    const request = cache.forRequest({ ...scope, actorId });
    expect(request.set("key", { status: "in-flight", timestamp: 0 })).toBe(false);
    expect(request.get("key")).toBeUndefined();
  });

  it("snapshots request scope rather than retaining a mutable caller object", () => {
    const cache = new MessageReplayCache();
    const mutable = { ...scope };
    const request = cache.forRequest(mutable);
    mutable.actorId = "owner-b";
    mutable.kind = "regular";
    request.set("key", { status: "in-flight", timestamp: 0 });
    request.set("key", { status: "done", result: payload, timestamp: 0 });
    expect(cache.forRequest(scope).get("key")?.result).toEqual(payload);
    expect(cache.forRequest(mutable).get("key")).toBeUndefined();
  });
});
