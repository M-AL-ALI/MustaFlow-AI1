# Orax Desktop Signing Setup

This runbook explains what MustaFlow AI needs before Orax Desktop can become a public Windows
download. It is intentionally separate from the product code: users do not sign Orax, do not use the
GitHub repo, and do not see the release secrets.

## Current recommendation

Use the Internal unsigned installer for product smoke testing first. The installer can be built and
installed locally, but it is not suitable for public distribution because Windows reports it as
`NotSigned`.

The safe order is:

1. Build the internal unsigned installer.
2. Install it on a trusted Windows machine.
3. Sign in with a MustaFlow AI account.
4. Confirm host registration, heartbeat, relay polling, pairing, diagnostics, and one desktop-backed
   Orax task.
5. Configure public-trust signing.
6. Run the internal signed release workflow.
7. Smoke test the signed installer.
8. Enable public download only after the signed smoke test passes.

Do not enable public download while the installer is unsigned.

## What users will do

Future users only need to:

1. Visit MustaFlow AI.
2. Click `Download for Windows`.
3. Install Orax Desktop.
4. Sign in with their MustaFlow AI account.

Future users do not add GitHub Actions secrets, do not sign the installer, and do not use the
MustaFlow AI source repository.

## What MustaFlow AI must set up

The existing workflow supports a PFX-style Windows code-signing certificate through electron-builder
environment variables.

GitHub Actions secrets:

```text
ORAX_WINDOWS_CSC_LINK
ORAX_WINDOWS_CSC_KEY_PASSWORD
ORAX_RELEASE_AWS_ACCESS_KEY_ID
ORAX_RELEASE_AWS_SECRET_ACCESS_KEY
```

GitHub Actions variables:

```text
ORAX_RELEASE_AWS_REGION
ORAX_DESKTOP_RELEASE_S3_URI
ORAX_DESKTOP_RELEASE_S3_ENDPOINT
```

`ORAX_WINDOWS_CSC_LINK` is the signing certificate material, usually a base64-encoded PFX file.
`ORAX_WINDOWS_CSC_KEY_PASSWORD` unlocks that certificate. The two release AWS secrets allow the
workflow to upload the installer and manifest to the controlled download host.

## Fastest path supported by the current workflow

1. Obtain an OV or EV Windows code-signing certificate for MustaFlow AI.
2. Export it as a `.pfx` file with a strong password.
3. Convert the PFX to base64 on a trusted machine:

   ```powershell
   [Convert]::ToBase64String([IO.File]::ReadAllBytes("C:\path\to\mustaflow-code-signing.pfx")) | Set-Clipboard
   ```

4. Add the clipboard value to the GitHub secret `ORAX_WINDOWS_CSC_LINK`.
5. Add the PFX password to `ORAX_WINDOWS_CSC_KEY_PASSWORD`.
6. Add the download-host upload secrets and variables.
7. Run `Orax Desktop Release` with:

   ```text
   channel = internal
   publish = true
   release_base_url = https://downloads.mustaflow.com/orax/desktop/windows
   ```

8. Install the signed internal build on a clean Windows machine.
9. Confirm the Health smoke checklist passes.

Only after that smoke test should the public website switch be enabled.

## Azure Artifact Signing path

Azure Artifact Signing is the preferred long-term direction because Microsoft manages the certificate
lifecycle and stores signing keys in managed HSM-backed infrastructure. It still requires Azure setup,
identity validation, and billing. It is not a free public-trust shortcut.

High-level setup:

1. Create or choose the Azure subscription owned by MustaFlow AI.
2. Create an Artifact Signing account.
3. Complete identity validation for the MustaFlow AI publisher identity.
4. Create a public-trust certificate profile.
5. Update the release workflow to use the Azure signing integration instead of `CSC_LINK`.
6. Run the signed internal release.
7. Smoke test before public download.

The current GitHub workflow is already ready for the PFX route. The Azure Artifact Signing route is a
future workflow integration task, not something users need.

## Orax Desktop Public Go-Live Checklist

After signing is configured, use the public go-live checklist before enabling the website download
switch:

```powershell
pnpm --filter @workspace/orax-desktop run verify:phase3w
```

The go-live checklist keeps signing, upload, manifest validation, signed internal smoke testing,
rollback, Health smoke checklist, and Support Diagnostics export in one release gate. It does not
replace the real Windows smoke test; it prevents the repository from drifting away from the required
release controls while that operational test is pending.

## Public download gate

Keep the website disabled until the signed internal smoke test passes:

```text
VITE_ORAX_DESKTOP_PUBLIC_DOWNLOAD_ENABLED=false
```

When signing and smoke testing are complete, set:

```text
VITE_ORAX_DESKTOP_PUBLIC_DOWNLOAD_ENABLED=true
VITE_ORAX_DESKTOP_RELEASE_MANIFEST_URL=https://downloads.mustaflow.com/orax/desktop/windows/orax-desktop-windows-latest.json
```

The product page must keep showing installer status instead of a fake download link whenever the
manifest is missing, invalid, or unsigned-release validation has not passed.
