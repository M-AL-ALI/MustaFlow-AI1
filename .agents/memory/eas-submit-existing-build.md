---
name: EAS submit an already-built iOS build to TestFlight
description: Decoupled eas submit --id flow, authoritative GraphQL submit status, and native-splash-baked-at-build
---

## Decoupled submit (safer than --auto-submit)
To ship an already-FINISHED EAS build, run a standalone `eas submit --platform ios --profile testflight --id <buildId> --non-interactive` instead of `eas build --auto-submit`.

**Why:** a failed submit burns the build number (see eas-submit-duplicate-build-number.md), so verify the build reached `status:FINISHED` *first*, then submit. Decoupling lets you confirm the build before risking the number.

**How to apply:** reuse the exact ASC setup from `artifacts/ora-mobile/scripts/build-testflight.sh` — reconstruct the space-flattened `EXPO_ASC_KEY_P8` into a temp PEM (strip markers, `'\n'.join(raw.split())`, re-wrap, validate with `openssl pkey -noout`), then export `EXPO_ASC_API_KEY_PATH` + `EXPO_ASC_KEY_ID` + `EXPO_ASC_ISSUER_ID` (+ `EXPO_APPLE_TEAM_TYPE=INDIVIDUAL`). The ASC key is already registered on EAS servers, so eas finds it automatically ("App Store Connect API Key already set up").

## Authoritative status + setsid cleanup gotcha
Submit takes minutes, so run it backgrounded via `setsid`. The authoritative status is GraphQL `submissions{byId(submissionId){status}}` (FINISHED = Apple accepted). The setsid-detached eas-cli process exits when the parent shell ends WITHOUT flushing its final success line and WITHOUT running its trailing `rm -f` cleanup — so the temp `.p8` private key is left in /tmp. Always `rm -f /tmp/AuthKey_*.p8` yourself after confirming FINISHED via GraphQL.

## Native splash/icon are baked at build time
A changed `splash.image` (or icon) does NOT appear in an existing on-device build — the launch image is compiled into the binary. Fixing the asset + republishing the web app is not enough; you must cut a FRESH native build and have the user delete + reinstall (iOS caches the old launch image even on update).
