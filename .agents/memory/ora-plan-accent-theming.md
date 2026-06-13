---
name: Ora plan accent theming
description: How the Ora chat surface applies the per-plan accent color, and why OraBubble is exempt.
---

# Ora plan accent theming

The Ora chat surface tints itself by the user's plan tier (free / core / wave). The accent
is threaded through one CSS custom property, **not** by passing a color to every element.

**Rule:** `oraAccentHsl(tier)` returns *channel-only* HSL (e.g. `"217 90% 60%"`, no `hsl()`
wrapper); `oraAccentColor(tier)` wraps it. The panel root sets
`style={{ "--ora-accent-hsl": oraAccentHsl(tier) }}` so every descendant can use
`[hsl(var(--ora-accent-hsl))]` and opacity variants `[hsl(var(--ora-accent-hsl)/0.07)]`.
`DynamicAtom` does not read the var (it's SVG, parsed in JS), so atoms must get
`accentColor={oraAccentColor(tier)}` explicitly.

**Why:** before this, ~38 spots hardcoded purple `hsl(265 85% 65%)`, so upgrading only
recolored the top-left badge/atom. The CSS-var cascade makes the whole surface follow the
plan in one place. Free tier still resolves to `265 85% 65%`, so free rendering is unchanged.

**Tier colors:** free=`265 85% 65%` (purple), core=`217 90% 60%` (blue, was teal
`175 70% 55%`), wave=`35 85% 60%` (amber).

**How to apply:** any new colored element on the Ora `/ora` surface must use
`var(--ora-accent-hsl)`, never a hardcoded purple. New `DynamicAtom`s need the
`accentColor` prop.

**OraBubble exemption:** `OraBubble` (`ora-bubble.tsx`) renders only on the landing page
and only when `!isSignedIn`, so it is always anonymous → always free tier. Its core/wave
accent branches are unreachable dead code; do NOT spend effort threading the CSS var there.
It keeps a duplicate `oraAccentColor` helper only for textual consistency with `ora-panel`.
