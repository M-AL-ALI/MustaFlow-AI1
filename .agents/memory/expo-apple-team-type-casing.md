---
name: EXPO_APPLE_TEAM_TYPE casing
description: EAS CLI requires all-caps enum value for EXPO_APPLE_TEAM_TYPE; Replit secret is stored as "Individual" which fails.
---

# EXPO_APPLE_TEAM_TYPE Must Be All-Caps

EAS CLI validates the Apple Team Type against a strict enum: `IN_HOUSE`, `COMPANY_OR_ORGANIZATION`, `INDIVIDUAL`.

The Replit secret `EXPO_APPLE_TEAM_TYPE` is stored as `"Individual"` (mixed case), which EAS rejects with:
> Invalid Apple Team Type: Individual. Must be one of IN_HOUSE, COMPANY_OR_ORGANIZATION, INDIVIDUAL

**Why:** EAS CLI does a strict enum comparison, not case-insensitive.

**How to apply:**
- For non-interactive EAS builds from scripts, prefix the command with `EXPO_APPLE_TEAM_TYPE=INDIVIDUAL` to override the inherited env value.
- The Replit secret itself should be updated to `INDIVIDUAL` for a permanent fix (Replit Secrets panel → EXPO_APPLE_TEAM_TYPE → change to `INDIVIDUAL`).
- This is only relevant for the non-interactive `--non-interactive` EAS CLI path that needs to validate/create credentials.
