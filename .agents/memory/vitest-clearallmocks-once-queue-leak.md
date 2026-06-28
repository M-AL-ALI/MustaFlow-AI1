---
name: vi.clearAllMocks once-queue leak
description: clearAllMocks does not drain mockResolvedValueOnce queues — unconsumed entries bleed into the next test.
---

## Rule
Use `vi.resetAllMocks()` in `beforeEach` whenever tests can leave unconsumed `mockResolvedValueOnce` entries.

## Why
`vi.clearAllMocks()` only clears `mock.calls / mock.results / mock.instances`. It does NOT drain the internal `specificMockImpls` stack that `mockResolvedValueOnce` / `mockReturnValueOnce` push to. If a test queues two Once values but only consumes one (e.g., the second call is served from a module-level cache), the leftover Once bleeds into the next test and causes unexpected mock return values.

`vi.resetAllMocks()` clears both the call history AND the Once queue, preventing cross-test contamination.

## How to apply
- In any test file with a module-level cache (e.g., `_tierCache` in authed-user.ts), pair `vi.resetAllMocks()` with explicit cache eviction in `beforeEach`.
- After `resetAllMocks()`, re-establish any default mock implementations immediately (e.g., `isSuperuserMock.mockResolvedValue(false)`).
- Only use `clearAllMocks()` when you are certain every Once value will be consumed in its test.
