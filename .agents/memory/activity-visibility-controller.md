---
name: Activity-visibility controller pattern
description: scheduleClear/notifyVisible defers first-token clear so an activity label has time to paint when the token arrives in the same XHR burst.
---

## The rule

`createActivityVisibilityController()` (lib/activity-visibility.ts) exposes three methods:
- `notifyVisible()` — call when a new activity step becomes visible; starts/resets the minimum-show window; cancels any pending `scheduleClear` timer.
- `scheduleClear(doClear)` — call when the first token arrives; if `notifyVisible()` was called within `ACTIVITY_MIN_SHOW_MS` (200ms), defers `doClear` until the window expires; otherwise calls `doClear()` immediately.
- `dispose()` — cancel any armed timer; call on component unmount.

**Why:** React (and RN's XHR `onreadystatechange`) batches state updates when an SSE activity frame and the first token arrive in the same burst. The activity label can be set and cleared before it ever paints. The 200ms deferred clear gives the render loop time to flush.

**How to apply:**
- `pushActivity` calls `activityVisibilityRef.current.notifyVisible()` BEFORE `setStreamActivity`.
- First-token handler calls `activityVisibilityRef.current.scheduleClear(() => setStreamActivity(null))` instead of `setStreamActivity(null)` directly.
- Cleanup `useEffect` calls `ctrl.dispose()` on unmount.

## Test pitfall

Controller behavior tests MUST call `notifyVisible()` before `scheduleClear()`. Without it, `minShowUntil = 0`, `remaining ≤ 0`, and `doClear` runs immediately (correct fast-path for no-activity sessions). Tests that skip `notifyVisible()` will see `cleared = true` instantly and fail on the "not yet cleared" assertion.

```typescript
// Correct test setup:
ctrl.notifyVisible();          // arm the minimum-show window
ctrl.scheduleClear(cb);        // now defers by ACTIVITY_MIN_SHOW_MS
vi.advanceTimersByTime(ACTIVITY_MIN_SHOW_MS - 1);
expect(cleared).toBe(false);   // still within window
vi.advanceTimersByTime(1);
expect(cleared).toBe(true);    // window elapsed
```

## Test mock gap (realtime-session.test.ts)

When `realtime.ts` imports `hasOraRepoSignal` and `hasActiveOraRepoSession` from `repo-analyst`, the `vi.mock("../../../lib/public-ai/repo-analyst")` block must include both or they run against the real DB and crash the route (500). Default both to `false`:

```typescript
hasOraRepoSignal: repoContext.hasSignal,        // mockReturnValue(false) in beforeEach
hasActiveOraRepoSession: repoContext.hasSession, // mockResolvedValue(false) in beforeEach
```

Set `repoContext.hasSession.mockResolvedValue(true)` in any test that expects the repo to be resolved.
