# Ora Talk-to-Ora — Realtime Voice Reconnect QA

Date: 2026-07-04
Status: Automated coverage complete; manual device validation pending per
follow-up tasks.

---

## Overview

When the live WebRTC session drops (ICE disconnection, connection failure, or
data-channel close/error), Talk-to-Ora attempts exactly **one** automatic
reconnect before falling back to the legacy whisper→chat→TTS loop.

The state machine is the same on web and mobile:

```
listening
  └─ handleConnectionDrop()
       ├─ reconnectUsed = false → networkQuality = "reconnecting"
       │                          scheduleReconnect(RECONNECT_DELAY_MS)
       │                            └─ success → networkQuality = "good"  (new PC/DC)
       │                            └─ failure → networkQuality = "legacy" (enterLegacyFallback)
       │
       └─ reconnectUsed = true  → networkQuality = "legacy"  (straight to fallback)
```

NetInfo (mobile) / window.online (web) short-circuit the pending timer and
fire the reconnect immediately when connectivity returns.

---

## Automated Test Results (2026-07-04)

### Web hook — `use-ora-realtime-voice.ts`
File: `artifacts/mustaflow/src/hooks/__tests__/ora-realtime-reconnect.test.ts`
Run: `pnpm --filter @workspace/mustaflow exec vitest run src/hooks/__tests__/ora-realtime-reconnect.test.ts`

| # | Test | Status |
|---|------|--------|
| 1 | starts successfully → 'listening', networkQuality 'good' | PASS |
| 2 | ICE drop → networkQuality 'reconnecting', no fallbackReason | PASS |
| 3 | fires exactly ONE mint for auto-reconnect after RECONNECT_DELAY_MS | PASS |
| 4 | auto-reconnect mint error → networkQuality 'legacy', onFallback called | PASS |
| 5 | second drop goes straight to legacy (no third reconnect attempt) | PASS |
| 6 | no extra mint calls after second drop | PASS |
| 7 | connectionState 'failed' → same as ICE failure | PASS |
| 8 | data-channel 'close' → auto-reconnect fires | PASS |
| 9 | data-channel 'error' → auto-reconnect fires | PASS |
| 10 | window.online cancels pending timer, fires reconnect immediately | PASS |
| 11 | retry() clears fallbackReason and starts a fresh session | PASS |
| 12 | retry() resets the reconnect budget (future drop auto-reconnects once more) | PASS |

**12/12 PASS**

### Mobile hook — `useOraRealtimeVoiceNative.ts`
File: `artifacts/ora-mobile/hooks/__tests__/ora-mobile-reconnect.test.ts`
Run: `pnpm --filter @workspace/ora-mobile exec vitest run --config vitest.config.hooks.ts`

| # | Test | Status |
|---|------|--------|
| 1 | starts successfully → 'listening', networkQuality 'good' | PASS |
| 2 | ICE drop → networkQuality 'reconnecting', no fallbackReason | PASS |
| 3 | fires exactly ONE mint for auto-reconnect after RECONNECT_DELAY_MS | PASS |
| 4 | auto-reconnect mint error → networkQuality 'legacy', onFallback called | PASS |
| 5 | second drop goes straight to legacy | PASS |
| 6 | connectionState 'failed' → same as ICE failure | PASS |
| 7 | data-channel 'close' → auto-reconnect fires | PASS |
| 8 | data-channel 'error' → auto-reconnect fires | PASS |
| 9 | NetInfo event cancels pending timer, fires reconnect immediately | PASS |
| 10 | NetInfo event does NOT fire reconnect a second time (one-shot latch) | PASS |

**10/10 PASS**

### UI wiring assertions — `ora-panel.tsx`
File: `artifacts/mustaflow/src/pages/__tests__/ora-realtime-reconnect-ui.test.ts`

| # | Assertion | Status |
|---|-----------|--------|
| 1 | quality-dot gated on reconnecting while voiceConvActive | PASS |
| 2 | 'reconnecting' → pulsing amber dot, label "Reconnecting live voice…" | PASS |
| 3 | 'good' → green dot, no pulse | PASS |
| 4 | 'legacy' → grey dot "Using basic voice mode" | PASS |
| 5 | qualityDot.label rendered as aria-label for accessibility | PASS |
| 6 | fallbackNotice visible only when voiceTransport = 'fallback' and not dismissed | PASS |
| 7 | default fallback string when fallbackReason is null | PASS |
| 8 | Retry button shown exactly when networkQuality = 'legacy' | PASS |
| 9 | fallbackNotice (carrying fallbackReason) passed to OraVoiceModeButton | PASS |
| 10 | networkQuality exposed from hook return value | PASS |
| 11 | fallbackReason exposed from hook return value | PASS |
| 12 | retry() exposed for UI rebuild action | PASS |
| 13 | 'reconnecting' string present in hook | PASS |
| 14 | 'legacy' string present in hook | PASS |

**14/14 PASS**

---

## UI States — What the User Sees

| networkQuality | Quality dot | Fallback notice | Retry button |
|---------------|-------------|-----------------|--------------|
| `good` | Green, static | Hidden | Hidden |
| `degraded` | Amber, pulsing | Hidden | Hidden |
| `reconnecting` | Amber, pulsing | Hidden | Hidden |
| `legacy` | Grey, static | Visible (fallbackReason or default text) | Visible |

The quality dot is hidden when voiceTransport is `"fallback"` AND networkQuality
is NOT `"reconnecting"` (i.e., the session is fully in legacy mode and stable).

---

## Manual QA Checklist — Real Network Drop Scenarios

The following steps cannot be automated (require real device + network control).
They should be run on each significant change to the live-voice stack.

### Web (Desktop Browser)

- [ ] **Basic flow**: Open Talk-to-Ora, start Live Voice. Confirm green dot appears.
- [ ] **Simulated drop**: In DevTools → Network, set offline mode for ~3 s, then restore.
  - Expected: dot turns amber + pulses, "Reconnecting live voice…" aria-label.
  - Expected: after ~2 s, new RTCPeerConnection is attempted (check console).
  - Expected: if successful, dot returns green.
  - Expected: if failed, dot turns grey, fallback notice appears, Retry button appears.
- [ ] **Retry after legacy**: With fallback notice showing, tap Retry.
  - Expected: live voice rebuilds, dot returns green, notice disappears.
  - Expected: another drop → can auto-reconnect once more (budget reset).
- [ ] **Double drop (no double reconnect)**: Drop twice without recovering first.
  - Expected: second drop goes straight to legacy (no second amber wait period).
- [ ] **window.online early**: Drop → while amber, restore network before 2 s timer.
  - Expected: reconnect fires immediately (no wait for full RECONNECT_DELAY_MS).

### Mobile iOS / Android

- [ ] **Basic flow**: Open Ora mobile, start Live Voice. Confirm connection indicator.
- [ ] **Airplane mode drop**: Enable airplane mode for ~4 s, restore.
  - Expected: indicator shows reconnecting state.
  - Expected: NetInfo fires → reconnect attempt fires immediately on restore.
  - Expected: reconnect succeeds → back to listening state.
- [ ] **Connection chip ("Connection issues?")**: After a failed reconnect (or
  repeated audio stops), confirm chip appears giving the user an option to retry.
- [ ] **Quality dot colors**: Verify the mobile quality dot shows amber while
  reconnecting and grey once in legacy fallback.

### Acceptance Criteria

- No double auto-reconnect (state machine fires mint at most once per drop cycle).
- After Retry, the reconnect budget is fully reset (one more auto-reconnect available).
- Fallback notice includes the real failure reason when available.
- UI never shows a stale "Reconnecting…" state after the session has settled.

---

## Test-Seam Note (Mobile)

The mobile hook (`useOraRealtimeVoiceNative.ts`) uses a guarded CJS
`require("react-native-webrtc")` that cannot be intercepted by `vi.mock()` in
the Vite/ESM jsdom test environment (require throws ReferenceError in ESM scope).

Two exported test-seam functions bypass the guarded require:

```typescript
_setWebRTCModuleForTest(mod)   // inject fake module, set loadAttempted=true
_resetWebRTCCacheForTest()     // reset loadAttempted=false, cachedModule=null
```

These are clearly marked `TEST-SEAM ONLY` in source and are never called in
production code. Metro bundling is unaffected (the real require path is
preserved for native builds).
