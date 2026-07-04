---
name: Vitest WebRTC hook test patterns
description: Pitfalls and fixes when unit-testing React hooks that use RTCPeerConnection, setInterval, and authFetch with vitest + jsdom.
---

# Vitest WebRTC hook test patterns

## Rule 1 — RTCPeerConnection mock must be a regular function, not an arrow function

**Why:** The hook calls `new RTCPeerConnection()`. Arrow functions are not constructors; using one as a `vi.fn()` implementation throws a TypeError inside the hook's outer try-catch, causing `start()` to silently return `false`. Vitest emits a visible warning: "The vi.fn() mock did not use 'function' or 'class'".

**How to apply:** Declare the constructor mock as a named regular function:

```typescript
function FakeRTCPeerConnection(this: FakePeerConnection) {
  const inst = new FakePeerConnection();
  pcInstances.push(inst);
  return inst; // returning an object from new substitutes it for `this`
}
(global as any).RTCPeerConnection = FakeRTCPeerConnection;
```

## Rule 2 — Call vi.clearAllMocks() in beforeEach

**Why:** Without it, `vi.mocked(fn).mock.calls` accumulates across tests. Assertions about "exactly N mints were issued" fail by reporting totals from prior tests.

**How to apply:** `vi.clearAllMocks()` in `beforeEach`, before configuring `mockImplementation`.

## Rule 3 — Use bounded vi.advanceTimersByTimeAsync(N), never vi.runAllTimersAsync()

**Why:** `runAllTimersAsync` drains the timer queue until it is empty. `setInterval` timers (heartbeat every 30 s, duration countdown every 1 s) never empty the queue — vitest aborts with "Aborting after running 10000 timers, assuming an infinite loop."

**How to apply:** Use `vi.advanceTimersByTimeAsync(N)` where N is just past the constant being tested (e.g. 2500 for a 2000 ms reconnect delay). The heartbeat interval is 30 s, so advancing ≤ 5 s is safe.

## Rule 4 — vi.runAllMicrotasksAsync does not exist in vitest 4.x

**How to apply:** Use `await vi.advanceTimersByTimeAsync(0)` inside `act()` to flush pending Promise microtasks without advancing wall-clock timers.

## Rule 5 — Capturing RTCPeerConnection instances via a describe-scope array

Track all instances created during a test for multi-session tests (original + reconnect):

```typescript
const pcInstances: FakePeerConnection[] = [];

beforeEach(() => {
  pcInstances.length = 0; // clear without reassigning (preserves closure reference)
  (global as any).RTCPeerConnection = FakeRTCPeerConnection;
});
```

`pcInstances[0]` = original session, `pcInstances[1]` = reconnect session.
