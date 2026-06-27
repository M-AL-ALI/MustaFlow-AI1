---
name: Ora Mobile Deep Thinking tier gate
description: deepAllowed pattern mirrors website; where and how it's implemented on mobile
---

## Rule
`deepAllowed = session?.tier === "core" || session?.tier === "wave"` — must be enforced in the mobile PlusMenu exactly as on the website. Free/signed-in users are Instant-only.

## How to apply
- Derive from `session?.tier` (already fetched at mount via `getOraSession()`)
- Pass as `deepAllowed: boolean` prop to `PlusMenu`
- `ToolRow` accepts `disabled?` and `sublabel?` — use `disabled={!deepAllowed}` + `sublabel={deepAllowed ? "Step-by-step" : "Locked"}` + icon swap (`Gauge` → `Lock`)
- On unauthorized tap: `Alert.alert("Deep Thinking", "Deep Thinking is available with Core Pack or Deep Wave. Manage your plan on the MustaFlow website.")` — do NOT use an "upgrade in Settings" CTA; iOS is web-only purchases (see ora-mobile-web-only-purchases.md)
- `useEffect(() => { if (!deepAllowed && mode === "deep") setMode("instant"); }, [deepAllowed, mode])` — safety reset on tier drop

**Why:** Website gates Deep mode to core/wave only (line 336 of ora-panel.tsx). Mobile must mirror this or free users bypass the plan gate.
