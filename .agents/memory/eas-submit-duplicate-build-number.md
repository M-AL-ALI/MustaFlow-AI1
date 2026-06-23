---
name: EAS iOS submit duplicate build number
description: Why TestFlight resubmits fail with EAS_UPLOAD_TO_ASC_VERSION_DUPLICATE and the only real fix
---

## The Rule
If an `eas submit` (iOS) uploads the binary to Apple and THEN fails afterward, the build number is already permanently burned at Apple. Apple claims a build number the instant it receives the binary, regardless of any later step failing. Every resubmit of that same IPA then fails with `EAS_UPLOAD_TO_ASC_VERSION_DUPLICATE` ("Build number N for app version X.Y.Z has already been used").

**Why:** A long (~20 min) first submission can report failure while actually having completed the Apple upload. The number is consumed; the IPA is not reusable.

## How to Apply
- The fix is NOT a resubmit and NOT a credential/agreement/EAS-infra change. It is a **fresh build with a new build number**, then submit that new build. The build number is embedded in the IPA, so a full rebuild (~7-25 min) is mandatory — you cannot patch the number into an existing artifact.
- `autoIncrement: true` + `appVersionSource: "local"` in eas.json bumps `app.json` `ios.buildNumber` automatically on the next build (e.g. 17→18). EAS prints "Bumping expo.ios.buildNumber from N to N+1" and commits that change to app.json.

## Diagnosis Gotchas
- The real submission error is in GraphQL `submissions{byId{jobRun{status errors{errorCode message}}}}`. Top-level `logFiles`/`error` are empty/null — do not conclude "no error".
- To check what Apple actually has, query ASC API `/v1/builds?filter[app]=<ascAppId>&filter[processingState]=<STATE>` across PROCESSING and VALID. A burned-but-unusable number appears in NO processing state, yet is still rejected as duplicate — that combination confirms this exact failure mode.
- A clean submit reaches `status:FINISHED` with `jobRun.errors:[]`, and the new build shows up under `processingState=VALID` shortly after.
