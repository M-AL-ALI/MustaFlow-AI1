---
name: Ecosystem ticker marquee testing
description: How to verify the landing-page technology ticker (scroll, themes) and why hover-pause "failures" from synthetic pointers are not trustworthy.
---

# Ecosystem ticker marquee testing

The landing page's TechnologyEcosystemBanner is a CSS-keyframe marquee (`animation: ticker-left … infinite`) over a doubled brand array, with per-entry `render(isDark)` functions.

**What works for verification:**
- Assert scroll by sampling an entry's bounding box twice ~2s apart and comparing x (worked in both themes).
- Playwright contexts often default to `prefers-reduced-motion: reduce`, which renders the ticker as a static wrapped list — explicitly create the context with `reducedMotion: "no-preference"` to test the animated marquee, and treat the static list as the reduced-motion fallback, not a bug.
- Static Screenshot tool cannot reach the section (below ~3000px fold) and cannot toggle theme; use the testing subagent + the header ThemeToggle (aria-label "Switch to light mode").

**Hover-pause caveat:** the pause is `animationPlayState` set in onMouseEnter on the moving track. A tester reported "hover does not pause" while scroll/theme checks all passed. Playwright hovers on perpetually-moving elements fail actionability/stability and synthetic enter events are unreliable here — do NOT treat that verdict as a regression of an entry-only change, and don't "fix" the untouched track code on that evidence alone. If pause behavior ever matters, verify manually in a real browser.

**Why:** an entry-only diff (adding to the BRANDS array) cannot affect track handlers; chasing the synthetic-hover failure wastes a test round.
**How to apply:** any future ticker change re-verified by a tester — expect and pre-empt the reduced-motion and hover-pause traps in the test plan.
