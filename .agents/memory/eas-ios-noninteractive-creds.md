---
name: EAS iOS non-interactive credential setup
description: Full GraphQL flow required to pre-register iOS credentials before running eas build --non-interactive
---

## The Rule
`eas build --platform ios --non-interactive` will fail with "Distribution Certificate is not validated for non-interactive builds" unless iOS credentials are fully pre-registered in EAS via GraphQL API first. Setting `EXPO_ASC_*` env vars alone is not enough.

**Why:** EAS CLI env vars (`EXPO_ASC_KEY_ID`, `EXPO_ASC_ISSUER_ID`, `EXPO_ASC_KEY_P8`) are used for interactive session auth and auto-provisioning prompts, not for automated headless credential creation.

## How to Apply
When credentials are not yet set up for a project, run this sequence via GraphQL before the build:

1. **Check Apple** for existing Distribution Certificates: `GET /v1/certificates?filter[certificateType]=IOS_DISTRIBUTION` — one is likely already stored in EAS.
2. **Query EAS** for stored certs: `account.byName.appleTeams.appleDistributionCertificates` — get the EAS cert ID and Apple portal ID.
3. **Register Bundle ID** in Apple Developer portal: `POST /v1/bundleIds` (if not already present).
4. **Create App Store provisioning profile** via Apple ASC API: `POST /v1/profiles` with type `IOS_APP_STORE`, referencing the bundle ID and distribution certificate.
5. **Create `iosAppCredentials`** in EAS: `iosAppCredentials.createIosAppCredentials(appleTeamId, appId, appleAppIdentifierId)`.
6. **Register provisioning profile** in EAS: `appleProvisioningProfile.createAppleProvisioningProfile(profileContent, developerPortalIdentifier, accountId, appleAppIdentifierId)`.
7. **Create `iosAppBuildCredentials`** in EAS: `iosAppBuildCredentials.createIosAppBuildCredentials(iosDistributionType: APP_STORE, distributionCertificateId, provisioningProfileId, iosAppCredentialsId)`.
8. **Run build** with `EXPO_APPLE_TEAM_TYPE=INDIVIDUAL` (all-uppercase; `Individual` causes a 400 error).

## Key Gotchas
- `EXPO_APPLE_TEAM_TYPE` must be `INDIVIDUAL` (all-uppercase) — `Individual` is rejected with "Invalid Apple Team Type".
- Apple allows max 2-3 active Distribution Certificates; if 409 on create, query existing ones and check EAS for a stored match.
- Apple PLA must be accepted by the Account Holder before any ASC API cert calls work (403 FORBIDDEN_ERROR.PLA_NOT_ACCEPTED).
- `/dev/stdin` is not available in bash heredoc child_process calls; write keys to `/tmp` temp files instead.
- `IosAppBuildCredentialsInput.provisioningProfileId` is NON_NULL — must register the profile in EAS first.
