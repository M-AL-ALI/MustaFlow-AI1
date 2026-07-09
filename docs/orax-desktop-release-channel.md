# Orax Desktop Release Channel

This runbook defines the production release path for Orax Desktop. It is scoped to Orax Desktop distribution only. Do not change Ora, public-ai chat, AI Builder, or mobile Ora assistant behavior as part of this flow.

## Channel Model

Orax Desktop uses a controlled generic download channel:

```text
https://downloads.mustaflow.com/orax/desktop/windows
```

Expected files per release:

```text
Orax-Desktop-<version>-x64-Setup.exe
Orax-Desktop-<version>-x64-Setup.exe.blockmap
latest.yml
orax-desktop-windows-latest.json
```

The `.exe`, `.blockmap`, `latest.yml`, and generated JSON manifest are release artifacts. They are uploaded to the download host and must not be committed to git.

## Code signing gate

Public release is blocked until Windows code signing is configured.

Required controls:

- Windows code-signing certificate owned by MustaFlow AI.
- Certificate secret stored only in CI/release secrets.
- Certificate password stored separately from the certificate.
- Timestamping enabled by the signer.
- Clean Windows VM installation test after signing.
- Windows publisher details show `MustaFlow AI`.

The website must keep Orax Desktop behind early access until these controls are verified.

## Release artifact manifest

After building the installer, generate a deterministic metadata manifest:

```powershell
pnpm --filter @workspace/orax-desktop run package:win
pnpm --filter @workspace/orax-desktop run release:manifest
```

The manifest is written to:

```text
artifacts/orax-desktop/release/orax-desktop-windows-latest.json
```

It includes:

- product name
- app id
- platform and architecture
- release channel
- version
- installer file name
- size in bytes
- SHA-256 checksum
- generated download URL
- generated timestamp

Use `ORAX_DESKTOP_RELEASE_BASE_URL` to override the manifest base URL. Use `ORAX_DESKTOP_RELEASE_CHANNEL` to mark `internal`, `beta`, or `stable`.

## Verification

Repository-safe readiness:

```powershell
pnpm --filter @workspace/orax-desktop run verify:phase3h
```

Release artifact generation:

```powershell
pnpm --filter @workspace/orax-desktop run package:win
pnpm --filter @workspace/orax-desktop run release:manifest
```

Release workflow readiness:

```powershell
pnpm --filter @workspace/orax-desktop run verify:phase3i
```

## GitHub Actions release workflow

Manual workflow:

```text
.github/workflows/orax-desktop-release.yml
```

Workflow inputs:

- `channel`: `internal`, `beta`, or `stable`
- `publish`: `false` by default; `true` uploads to the configured download host
- `release_base_url`: public base URL written into the generated manifest

The workflow always:

1. Installs dependencies from the lockfile.
2. Runs `verify:phase3i`.
3. Builds the Windows installer.
4. Generates `orax-desktop-windows-latest.json`.
5. Uploads the installer, blockmap, `latest.yml`, and manifest as GitHub workflow artifacts.

The workflow only publishes to the download host when `publish=true`.

## Required GitHub secrets and variables

Signing secrets:

- `ORAX_WINDOWS_CSC_LINK`
- `ORAX_WINDOWS_CSC_KEY_PASSWORD`

Download-host secrets:

- `ORAX_RELEASE_AWS_ACCESS_KEY_ID`
- `ORAX_RELEASE_AWS_SECRET_ACCESS_KEY`

Download-host repository variables:

- `ORAX_RELEASE_AWS_REGION`
- `ORAX_DESKTOP_RELEASE_S3_URI`
- `ORAX_DESKTOP_RELEASE_S3_ENDPOINT` (optional, for S3-compatible hosts such as R2)

The workflow fails before publish if signing secrets are missing. Keep `publish=false` for dry-run builds and internal verification.

Before upload:

1. Confirm `verify:phase3h` passes.
2. Confirm `package:win` produces the installer.
3. Confirm `release:manifest` produces the JSON manifest.
4. Confirm all generated files remain under `artifacts/orax-desktop/release/`.
5. Confirm `git status` does not include generated installer artifacts.
6. Confirm the installer is signed before public release.
7. Confirm the installer runs on a clean Windows machine.
8. Confirm production sign-in, host heartbeat, pairing, and remote control.

## Upload Flow

Upload only after signing and smoke testing:

```text
release/Orax-Desktop-<version>-x64-Setup.exe
release/Orax-Desktop-<version>-x64-Setup.exe.blockmap
release/latest.yml
release/orax-desktop-windows-latest.json
```

The upload target should be versioned or immutable where possible. The public "latest" pointer should only be advanced after smoke tests pass.

## Rollback

Rollback means moving the public latest pointer back to the last known-good signed release.

Rollback requirements:

- Keep at least one previous signed release available.
- Keep previous `latest.yml` and `orax-desktop-windows-latest.json` manifests.
- Record why the rollback happened.
- Keep failed artifacts out of public download links.
- Do not delete the failed artifacts until investigation is complete.

## Product Page State

Until public signing is complete, the Orax product page should show:

- installer status flow with no fake download link
- signed release channel status
- internal release review copy

Do not expose a direct public download link until signing and production smoke are complete.

## Public download switch

The website download button is fail-closed. It only becomes a direct Windows installer link when
both conditions are true:

```text
VITE_ORAX_DESKTOP_PUBLIC_DOWNLOAD_ENABLED=true
VITE_ORAX_DESKTOP_RELEASE_MANIFEST_URL=https://downloads.mustaflow.com/orax/desktop/windows/orax-desktop-windows-latest.json
```

The product page fetches the manifest at runtime and validates:

- product is `Orax Desktop`
- app id is `ai.mustaflow.orax.desktop`
- platform is `win32`
- architecture is `x64`
- SHA-256 checksum is present
- `downloadUrl` points to the controlled Orax Desktop Windows release channel

If the switch is off, the manifest URL is missing, the manifest request fails, or the manifest does
not validate, the product page must keep showing installer status and a disabled installer CTA. It
must not route the download path to support tickets or any other non-installer destination. Do not
hard-code an installer URL into the website. The public download link must always come from the
signed release manifest.

Readiness check:

```powershell
pnpm --filter @workspace/orax-desktop run verify:phase3j
```

## Public go-live checklist

Before changing the website environment variables, run the full public go-live gate:

```powershell
pnpm --filter @workspace/orax-desktop run verify:phase3w
```

This gate confirms the repository still contains the signing setup guide, release workflow guards,
public-download fail-closed checks, Health smoke checklist guidance, Support Diagnostics export
requirements, and rollback plan. It is a repository gate only. The real signed Windows installer
still needs to pass manual smoke testing before public download is enabled.

Before enabling public download:

1. Confirm `verify:phase3j` passes.
2. Confirm GitHub Actions built and signed the installer.
3. Confirm `orax-desktop-windows-latest.json` is uploaded to the download host.
4. Confirm the manifest `downloadUrl` points to the signed installer.
5. Confirm a clean Windows machine can install, sign in, register heartbeat, pair mobile, run a
   small desktop-backed Orax task, and prepare a pull request.
6. Set `VITE_ORAX_DESKTOP_PUBLIC_DOWNLOAD_ENABLED=true` and the manifest URL in the website
   deployment environment.
7. Deploy the website and verify the product page shows `Download for Windows`.
