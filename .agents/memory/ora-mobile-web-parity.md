---
name: Ora Mobile ↔ website parity
description: Durable decisions when mirroring website Ora (ora-panel.tsx) into the Expo app (ora-mobile). Read before "fixing" perceived parity gaps.
---

The Expo app `artifacts/ora-mobile` is a native mirror of the website Ora panel
`artifacts/mustaflow/src/components/ora-panel.tsx` (source of truth). It is already
at high feature parity — composer (multiline input, send, attach files, pick image,
camera, web-search toggle, mode selector, mic STT, Talk live-voice, language, ghost
temporary chat, stop generation), streaming, sources, memory, datasets, images,
export. Verify claims against source before changing anything.

## The atom avatar

**Web `DynamicAtom` (components/ora/dynamic-atom.tsx) is DOM/CSS-only** — it animates
via `document` + CSS keyframes that do not exist in React Native. NEVER import it in
the mobile app.
**Why:** importing it crashes RN; hand-reimplementing animation is wasted effort.
**How to apply:** use `components/ora/OraAtom.tsx` — a static `react-native-svg`
snapshot of the atom's idle look (glow, two tilted orbit rings, electrons on ring
tips, highlighted core), tinted by the plan accent. Render it as the empty-state hero
(size ~56) and as the assistant-row avatar (size ~26).

## Memory save is intentionally manual-only on mobile

Website auto-saves non-sensitive memory candidates and only keeps the inline chip for
sensitive ones (gated by `askBeforeSensitive`). **Mobile never auto-saves** — every
candidate shows the `OraMemorySaveCandidate` chip and saves only on explicit tap.
**Why:** manual-only is strictly safer/more private than auto-save, and there is no
mobile save-candidate endpoint; do NOT "fix" mobile to auto-save to match web.
**How to apply:** the `memorySaveCandidateSensitive` flag drives only a warning note
on the chip, not behavior.

## Don't trust an explorer's "gaps" without source-checking

A parity audit false-positived "sources only render in export" — in fact mobile
renders citation sources directly in the assistant message (filtered by
`isSafeHttpUrl`). Always confirm against the actual render path before building.

## Acceptable mobile compactions (not gaps)

Usage/quota shows as the screen-header subtitle text rather than web's progress bars.
This is a deliberate mobile compaction, not a defect.

## Process mandate (after TestFlight build 20 was REJECTED on-device)

User chose **Option A** (native rebuild, screen by screen) over a WebView shell. Strict
screenshot-driven loop is now MANDATORY per screen, in order:
1. Website Ora screenshot (user's signed-in browser; `/ora` is auth-gated so I CANNOT
   capture it — ask the user, or build a source-accurate reference and have them verify).
2. TestFlight screenshot from the user's iPhone ("before"). I cannot capture native;
   the Expo web preview renders blank (Clerk-expo web error + auth gate).
3. Difference list. 4. Native fix. 5. Before/after. 6. User approval before next screen.
**Banned (user enforced):** never claim parity "from code", never call a result a
"native equivalent", never submit a TestFlight build until the user has reviewed.
**Screen priority order:** main-chat empty state → chat w/ messages → composer+keyboard
→ plus/tools menu → mic dictation → Talk to Ora → conversation/projects drawer → settings.

## The static atom is UNDER REVIEW, do not pre-dismiss animating it

Prior note called native atom animation "wasted effort." That predates the on-device
rejection. The web `DynamicAtom` is **alive** (orbiting electrons, breathing glow/core,
outer box-shadow halo); `OraAtom` is a frozen snapshot — a likely "feels different"
gap on a live device. Confirm against screenshots before deciding; if needed, animate
natively with react-native-reanimated (orbit + pulse), do NOT import DynamicAtom.
