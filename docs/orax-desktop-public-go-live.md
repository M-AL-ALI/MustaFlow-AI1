# Orax Desktop Public Go-Live Checklist

This checklist is the final public-release gate for Orax Desktop. It exists so the team does not
mistake "the code builds" for "the installer is safe to publish."

The rule is simple: Never publish unsigned installer builds. The website must stay in early-access
mode until every item below is complete.

## Public go-live gate

Run the repository-safe gate before changing website environment variables:

```powershell
pnpm --filter @workspace/orax-desktop run verify:phase3w
```

This command does not prove a real Windows installer works. It proves the repo still contains the
release controls, docs, workflow guards, public-download fail-closed checks, and Health guidance
needed before the real Windows smoke test.

## Required status before public download

| Area                       | Required state                                                                                                                         |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Certificate configured     | `ORAX_WINDOWS_CSC_LINK` and `ORAX_WINDOWS_CSC_KEY_PASSWORD` exist in GitHub Actions secrets.                                           |
| Download host configured   | Upload credentials and `ORAX_DESKTOP_RELEASE_S3_URI` are present in GitHub Actions.                                                    |
| Signed internal release    | `Orax Desktop Release` ran on the `internal` channel with `publish=true`.                                                              |
| Manifest uploaded          | `orax-desktop-windows-latest.json` is available on the controlled download host.                                                       |
| Signed internal smoke      | Clean Windows install, sign-in, host registration, heartbeat, pairing, relay polling, diagnostics, and one desktop-backed task passed. |
| Health smoke checklist     | The installed desktop Health page shows the checklist as ready or manually confirmed.                                                  |
| Support diagnostics export | Export succeeds or cancels cleanly and never displays local paths or secrets.                                                          |
| Rollback plan              | Previous signed installer and manifest are still available before the public pointer moves.                                            |
| Website env switch         | Public download variables are set only after the signed internal smoke passes.                                                         |

## Manual signed-in smoke

Use a clean Windows machine or VM:

1. Install the signed internal installer.
2. Open Orax Desktop.
3. Sign in with a MustaFlow AI account.
4. Register the host.
5. Confirm heartbeat is online.
6. Pair web or mobile.
7. Add a local project folder.
8. Ask Orax to inspect a small issue.
9. Review the selected files and patch proposal.
10. Apply the patch.
11. Verify the patch.
12. Prepare a pull request or confirm the expected blocker.
13. Export Support Diagnostics from Health.
14. Confirm the Health smoke checklist is complete.

If any step fails, keep public download disabled and fix the failing phase first.

## Website switch

Only after the signed internal smoke passes:

```text
VITE_ORAX_DESKTOP_PUBLIC_DOWNLOAD_ENABLED=true
VITE_ORAX_DESKTOP_RELEASE_MANIFEST_URL=https://downloads.mustaflow.com/orax/desktop/windows/orax-desktop-windows-latest.json
```

Then redeploy the website and verify:

- the product page shows `Download for Windows`
- the link comes from the release manifest, not a hard-coded path
- the manifest checksum matches the uploaded installer
- the fallback state still shows installer status if the manifest is unavailable

## Rollback plan

Before public download:

1. Keep the last known-good signed installer.
2. Keep the last known-good `latest.yml`.
3. Keep the last known-good `orax-desktop-windows-latest.json`.
4. Document how to move the public manifest pointer back.
5. Do not delete failed artifacts until the failure is understood.

Rollback means changing the public latest pointer back to the last known-good signed release. It
does not require users to configure GitHub or signing secrets.

## What users do

Users only download and install Orax Desktop, then sign in with MustaFlow AI. Users do not configure
the certificate, GitHub Actions, upload credentials, or release manifests.

## What MustaFlow AI owns

MustaFlow AI owns the certificate, release workflow, download host, manifest, public website switch,
and smoke-test decision. This keeps the installer trusted and keeps release control away from end
users.
