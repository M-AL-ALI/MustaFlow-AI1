---
name: Ora streaming feature flags
description: Three env vars required to enable Ora Live Response Streaming; common merge artifacts that break validation
---

## The three required streaming flags

All three must be set to `"true"` for streaming to be active end-to-end:

- `ORA_STREAMING_ENABLED` — backend gate in `artifacts/api-server/src/routes/public-ai/chat.ts`; without it `/chat/stream` returns 503 + `streamingFallback:true`.
- `VITE_ORA_STREAMING_ENABLED` — Vite bake-in in `artifacts/mustaflow/src/hooks/use-ora-chat.ts`; without it the frontend throws `streaming_disabled` and falls back to `/chat` before even trying the stream.
- `EXPO_PUBLIC_ORA_STREAMING_ENABLED` — mobile gate in `artifacts/ora-mobile/lib/api.ts`; `sendChatStream` returns null if not set.

After setting VITE vars, the mustaflow web workflow must be restarted — Vite bakes them in at startup.

**Why:** These flags were all `undefined` after the streaming feature merged (tasks #1446–#1448), causing silent fallback to non-streaming chat for all users.

**How to apply:** If streaming appears to work in tests but not live, check these vars first via `viewEnvVars`.

## OraMessage field naming: viaFallback vs isStreamingFallback

The web `OraMessage` (in `use-ora-chat.ts`) uses `viaFallback?: boolean` — NOT `isStreamingFallback`.
The mobile `OraMessage` (in `ora-mobile/lib/types.ts`) also uses `viaFallback?: boolean`.

Both `ora-panel.tsx` and mobile `index.tsx` must reference `viaFallback`, not `isStreamingFallback`. Merge artifacts from the streaming task incorrectly introduced `isStreamingFallback` in several call sites — always fix to `viaFallback`.

## AsyncGenerator literal-type inference blocks mockImplementation

When a `vi.fn(async function* () { yield "token1"; yield "token2"; })` mock is initialized with string literals, TypeScript infers the mock type as `AsyncGenerator<"token1" | "token2", ...>`. Later `mockImplementation(async function* () { yield "Hello"; })` fails TS2345 because `"Hello" ≠ "token1"`.

Fix: annotate the initial mock with an explicit return type:
```typescript
vi.fn(async function* (): AsyncGenerator<string> {
  yield "token1";
  yield "token2";
})
```

## Duplicate properties in vi.mock object literals (merge artifact)

Merging streaming test files can produce duplicate property keys in a `vi.mock(...)` factory object (TS1117). Remove the second occurrence — the first is canonical.
