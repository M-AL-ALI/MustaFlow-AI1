---
name: Ora Mobile theme system
description: How light/dark mode is implemented in artifacts/ora-mobile
---

ThemeContext (context/ThemeContext.tsx) is the source of truth for mobile theme.
- AsyncStorage key: "ora:themeOverride", values: "system" | "light" | "dark"
- Default on first install: "dark"
- ThemeProvider wraps the root in app/_layout.tsx
- ThemedStatusBar component reads effectiveScheme and sets expo-status-bar style

useColors (hooks/useColors.ts) reads from useTheme().effectiveScheme, not useColorScheme() directly.

Both light and dark palettes are in constants/colors.ts.
Light palette keys are identical to dark palette keys — safe to swap.
Light tokens were derived from artifacts/mustaflow/src/index.css :root block (HSL→hex).

**Why:** Website Ora supports both light and dark mode; mobile must match.
**How to apply:** Any new color usage must go through useColors() — never hardcode dark-only colors.
