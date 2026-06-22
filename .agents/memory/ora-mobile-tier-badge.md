---
name: Ora Mobile tier badge colors
description: How plan tier badge colors are computed in mobile to match website Ora
---

tierAccentColor(tier) in artifacts/ora-mobile/app/(home)/index.tsx maps tier→hex.
These hex values are the computed output of the website's oraAccentHsl() HSL strings:
- "core"  → #3D83F5  (hsl 217 90% 60% — Core Pack blue)
- "wave"  → #F0A742  (hsl 35 85% 60%  — Deep Wave amber)
- default → #995AF2  (hsl 265 85% 65% — Free / anonymous purple)

Badge style: border + text = accentColor; background = accentColor + "20" (8-char RRGGBBAA hex = ~12% opacity).
Labels: tierLabel() → "Core Pack" / "Deep Wave" / "Free" — matches website oraTierLabel() exactly.
Tier comes from real /api/public-ai/session response field tier.

**Why:** React Native can't use CSS hsl() strings; hex with RGBA alpha suffix (#RRGGBBAA) is supported on iOS 13+/Android 8+.
**How to apply:** Always derive mobile colors from website HSL tokens via manual HSL→hex conversion; never hardcode generic grey.
