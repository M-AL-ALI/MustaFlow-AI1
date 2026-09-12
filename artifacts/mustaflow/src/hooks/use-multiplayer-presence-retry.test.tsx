import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MULTIPLAYER_MAX_RECONNECT_ATTEMPTS,
  useMultiplayerPresence,
} from "./use-multiplayer-presence";

class TestWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  static instances: TestWebSocket[] = [];
  readyState = TestWebSocket.CONNECTING;
  binaryType = "";
  onopen: (() => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  send = vi.fn();
  close = vi.fn(() => this.remoteClose(1000));

  constructor(readonly url: string) {
    TestWebSocket.instances.push(this);
  }
  open() {
    this.readyState = TestWebSocket.OPEN;
    this.onopen?.();
  }
  remoteClose(code: number) {
    this.readyState = TestWebSocket.CLOSED;
    this.onclose?.({ code });
  }
  frame(value: unknown) {
    this.onmessage?.({ data: JSON.stringify(value) });
  }
}

const peer = {
  id: "verified-peer",
  name: "Project member",
  imageUrl: "/member.png",
  kind: "owner",
  location: "Preview",
  grantId: null,
  grantExpiresAt: null,
};
const latest = () => TestWebSocket.instances[TestWebSocket.instances.length - 1]!;
const advance = (milliseconds: number) => act(() => vi.advanceTimersByTime(milliseconds));

beforeEach(() => {
  vi.useFakeTimers();
  TestWebSocket.instances = [];
  vi.stubGlobal("WebSocket", TestWebSocket);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("bounded collaboration reconnects", () => {
  it("recovers a transient admission failure through the existing retry path", () => {
    const { result } = renderHook(() => useMultiplayerPresence(61, true));
    act(() => {
      latest().open();
      latest().frame({
        type: "error",
        code: "presence_temporarily_unavailable",
        message: "Collaboration could not connect. Retrying shortly.",
      });
      latest().remoteClose(4413);
    });
    expect(result.current.status).toBe("closed");
    advance(1000);
    expect(TestWebSocket.instances).toHaveLength(2);
    act(() => {
      latest().open();
      latest().frame({ type: "hello", you: peer });
    });
    expect(result.current.status).toBe("open");
    expect(result.current.message).toBeNull();
  });

  it("does not claim live collaboration from the transport opening alone", () => {
    const { result } = renderHook(() => useMultiplayerPresence(61, true, "Preview"));
    act(() => latest().open());
    expect(result.current.status).toBe("connecting");
    act(() => latest().frame({ type: "hello", you: peer }));
    expect(result.current.status).toBe("open");
  });

  it("stops the observed Unauthorized-frame loop without relying on a server close code", () => {
    const { result } = renderHook(() => useMultiplayerPresence(61, true, "Preview"));
    act(() => {
      latest().open();
      latest().frame({ type: "error", message: "Unauthorized" });
    });
    advance(60_000);
    expect(TestWebSocket.instances).toHaveLength(1);
    expect(result.current.message).toBe("Unauthorized");
    expect(result.current.status).toBe("closed");
  });

  it.each([4401, 4403, 4003, 4409])(
    "does not automatically retry permanent close code %s",
    (code) => {
      const { result } = renderHook(() => useMultiplayerPresence(61, true));
      act(() => {
        latest().open();
        latest().remoteClose(code);
      });
      advance(60_000);
      expect(TestWebSocket.instances).toHaveLength(1);
      expect(result.current.status).toBe("closed");
      expect(result.current.message).not.toBeNull();
    },
  );

  it.each(["grant_closed", "access_removed"])(
    "stops after a %s message and clears the roster",
    (type) => {
      const { result } = renderHook(() => useMultiplayerPresence(61, true));
      act(() => {
        latest().open();
        latest().frame({ type: "hello", you: peer });
        latest().frame({ type: "roster", peers: [peer] });
        latest().frame({ type, message: "Project access ended." });
      });
      advance(60_000);
      expect(TestWebSocket.instances).toHaveLength(1);
      expect(result.current.peers).toEqual([]);
      expect(result.current.self).toBeNull();
      expect(result.current.message).toBe("Project access ended.");
    },
  );

  it("caps unclassified failures even when every transport briefly opens", () => {
    const { result } = renderHook(() => useMultiplayerPresence(61, true));
    for (let attempt = 0; attempt <= MULTIPLAYER_MAX_RECONNECT_ATTEMPTS; attempt += 1) {
      act(() => {
        latest().open();
        latest().remoteClose(1006);
      });
      advance(10_000);
    }
    advance(60_000);
    expect(TestWebSocket.instances).toHaveLength(MULTIPLAYER_MAX_RECONNECT_ATTEMPTS + 1);
    expect(result.current.message).toBe("Connection interrupted. Reconnect to try again.");
    expect(result.current.message).not.toMatch(/unauthorized|forbidden/i);
  });

  it("counts online-expedited retries without scheduling duplicate or unlimited attempts", () => {
    const { result } = renderHook(() => useMultiplayerPresence(61, true));
    for (let attempt = 0; attempt < MULTIPLAYER_MAX_RECONNECT_ATTEMPTS; attempt += 1) {
      act(() => latest().remoteClose(1006));
      act(() => window.dispatchEvent(new Event("online")));
      expect(TestWebSocket.instances).toHaveLength(attempt + 2);
      act(() => window.dispatchEvent(new Event("online")));
      advance(10_000);
      expect(TestWebSocket.instances).toHaveLength(attempt + 2);
    }
    act(() => latest().remoteClose(1006));
    for (let event = 0; event < 3; event += 1) {
      act(() => window.dispatchEvent(new Event("online")));
      advance(60_000);
    }
    expect(TestWebSocket.instances).toHaveLength(MULTIPLAYER_MAX_RECONNECT_ATTEMPTS + 1);
    expect(result.current.message).toBe("Connection interrupted. Reconnect to try again.");
  });

  it("requires explicit reconnect to restart an exhausted budget after repeated online events", () => {
    const { result } = renderHook(() => useMultiplayerPresence(61, true));
    for (let attempt = 0; attempt <= MULTIPLAYER_MAX_RECONNECT_ATTEMPTS; attempt += 1) {
      act(() => latest().remoteClose(1006));
      advance(10_000);
    }
    const exhaustedCount = MULTIPLAYER_MAX_RECONNECT_ATTEMPTS + 1;
    for (let event = 0; event < 3; event += 1) {
      act(() => window.dispatchEvent(new Event("online")));
      advance(60_000);
    }
    expect(TestWebSocket.instances).toHaveLength(exhaustedCount);
    act(() => result.current.reconnect?.());
    expect(TestWebSocket.instances).toHaveLength(exhaustedCount + 1);
    act(() => latest().remoteClose(1006));
    advance(1_000);
    expect(TestWebSocket.instances).toHaveLength(exhaustedCount + 2);
  });

  it("backs off transient failures and resets the budget after an authenticated greeting", () => {
    const { result } = renderHook(() => useMultiplayerPresence(61, true));
    act(() => latest().remoteClose(1006));
    advance(999);
    expect(TestWebSocket.instances).toHaveLength(1);
    advance(1);
    expect(TestWebSocket.instances).toHaveLength(2);
    act(() => {
      latest().open();
      latest().frame({ type: "hello", you: peer });
      latest().remoteClose(1006);
    });
    advance(1_000);
    expect(TestWebSocket.instances).toHaveLength(3);
    expect(result.current.message).toBeNull();
  });

  it("allows an explicit reconnect after credentials or access have changed", () => {
    const { result } = renderHook(() => useMultiplayerPresence(61, true));
    act(() => {
      latest().open();
      latest().frame({ type: "error", message: "Unauthorized" });
    });
    expect(result.current.reconnect).toBeTypeOf("function");
    act(() => result.current.reconnect?.());
    expect(TestWebSocket.instances).toHaveLength(2);
    act(() => {
      latest().open();
      latest().frame({ type: "hello", you: peer });
    });
    expect(result.current.status).toBe("open");
    expect(result.current.message).toBeNull();
  });

  it("recovers a transient disconnection on online without reviving a permanent denial", () => {
    renderHook(() => useMultiplayerPresence(61, true));
    act(() => latest().remoteClose(1006));
    act(() => window.dispatchEvent(new Event("online")));
    expect(TestWebSocket.instances).toHaveLength(2);
    act(() => {
      latest().open();
      latest().frame({ type: "error", message: "Unauthorized" });
    });
    act(() => window.dispatchEvent(new Event("online")));
    advance(60_000);
    expect(TestWebSocket.instances).toHaveLength(2);
  });

  it("does not let an obsolete socket deny a newly selected project", () => {
    const { result, rerender } = renderHook(
      ({ projectId }) => useMultiplayerPresence(projectId, true),
      {
        initialProps: { projectId: 61 },
      },
    );
    const obsolete = latest();
    rerender({ projectId: 62 });
    act(() => {
      obsolete.frame({ type: "error", message: "Unauthorized" });
      obsolete.remoteClose(4401);
      latest().open();
      latest().frame({ type: "hello", you: { ...peer, id: "project-62-peer" } });
    });
    expect(result.current.message).toBeNull();
    expect(result.current.self?.id).toBe("project-62-peer");
    expect(result.current.status).toBe("open");
  });

  it.each([
    ["multiplayer_editing_disabled", "Live editing is turned off for this project."],
    [
      "multiplayer_editing_read_only",
      "Editing requires editor access. Your viewing connection remains open.",
    ],
    ["multiplayer_editing_unavailable", "Editing access could not be verified. Try again shortly."],
    ["support_presence_read_only", "Support access is read-only."],
  ])("keeps %s separate from connection denial", (code, message) => {
    const { result } = renderHook(() => useMultiplayerPresence(61, true));
    act(() => {
      latest().open();
      latest().frame({ type: "hello", you: peer });
      latest().frame({
        type: "error",
        code,
        message,
      });
    });
    expect(result.current.status).toBe("open");
    expect(latest().close).not.toHaveBeenCalled();
    expect(result.current.message).toBe(message);
  });

  it("clears reconnect work on unmount", () => {
    const { unmount } = renderHook(() => useMultiplayerPresence(61, true));
    act(() => latest().remoteClose(1006));
    unmount();
    advance(60_000);
    expect(TestWebSocket.instances).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("exhausted transient admission feedback", () => {
  it("replaces a retry promise at exhaustion without restarting on online events", () => {
    const { result } = renderHook(() => useMultiplayerPresence(61, true));
    for (let attempt = 0; attempt <= MULTIPLAYER_MAX_RECONNECT_ATTEMPTS; attempt += 1) {
      act(() => {
        latest().open();
        latest().frame({
          type: "error",
          code: "presence_temporarily_unavailable",
          message: "Collaboration could not connect. Retrying shortly.",
        });
        latest().remoteClose(4413);
      });
      if (attempt < MULTIPLAYER_MAX_RECONNECT_ATTEMPTS) {
        expect(result.current.message).toBe("Collaboration could not connect. Retrying shortly.");
      }
      advance(10_000);
    }
    const exhaustedCount = MULTIPLAYER_MAX_RECONNECT_ATTEMPTS + 1;
    expect(TestWebSocket.instances).toHaveLength(exhaustedCount);
    expect(result.current.status).toBe("closed");
    expect(result.current.message).toBe("Connection interrupted. Reconnect to try again.");
    act(() => window.dispatchEvent(new Event("online")));
    advance(60_000);
    expect(TestWebSocket.instances).toHaveLength(exhaustedCount);
    act(() => result.current.reconnect?.());
    expect(TestWebSocket.instances).toHaveLength(exhaustedCount + 1);
    expect(result.current.message).toBeNull();
    act(() => {
      latest().open();
      latest().frame({ type: "hello", you: peer });
    });
    expect(result.current.status).toBe("open");
    expect(result.current.message).toBeNull();
  });
});
