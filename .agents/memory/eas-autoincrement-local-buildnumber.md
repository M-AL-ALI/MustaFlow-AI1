---
name: EAS autoIncrement with local appVersionSource
description: Never manually pre-bump app.json buildNumber for TestFlight builds — EAS bumps it at build time and a manual bump skips a number.
---

The `testflight` profile in `eas.json` has `"autoIncrement": true` with `appVersionSource: local`. At build time EAS reads `app.json`'s `ios.buildNumber`, increments it, uses the incremented value for the binary, and writes it back into the local `app.json` (dirtying the tree, since builds run with `EAS_NO_VCS=1`).

**Rule:** never manually bump `ios.buildNumber` before queueing a TestFlight build. Leave the last-shipped number in place; autoIncrement produces last+1.

**Why:** a manual pre-bump to N makes the binary ship as N+1 and permanently skips N (this happened: pre-bump to 50 shipped as Apple build 51). Apple build numbers must be strictly increasing, so skipped numbers cannot be reclaimed.

**How to apply:**
- Queue the build with `app.json` untouched; after queueing, `app.json` will show the new shipped number via the writeback — commit that writeback so the repo matches the shipped binary.
- Verify the actual shipped number via GraphQL `builds.byId { appBuildVersion }`, not the wrapper script's intent.
- If a specific number is truly required, set `app.json` to number-1 or remove `autoIncrement` for that run.
