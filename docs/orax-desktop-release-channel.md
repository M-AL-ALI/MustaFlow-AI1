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

- early-access request flow
- signed release channel status
- internal release review copy

Do not expose a direct public download link until signing and production smoke are complete.
