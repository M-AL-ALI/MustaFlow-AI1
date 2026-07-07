# Orax Desktop Windows Installer

This runbook covers the Windows installer build for Orax Desktop. It is scoped to Orax only and must not change Ora, public-ai, AI Builder, or mobile Ora assistant behavior.

## Build Inputs

- Package: `artifacts/orax-desktop`
- Builder config: `artifacts/orax-desktop/electron-builder.yml`
- App name: `Orax Desktop`
- App ID: `ai.mustaflow.orax.desktop`
- Publisher: `MustaFlow AI`
- Build resources: `artifacts/orax-desktop/build/`
- Output folder: `artifacts/orax-desktop/release/`

The release folder is ignored by git. Do not commit generated `.exe`, `.blockmap`, unpacked app folders, or signing artifacts.

## Local Windows Build

From the repo root:

```powershell
pnpm install
pnpm --filter @workspace/orax-desktop run typecheck
pnpm --filter @workspace/orax-desktop run build
pnpm --filter @workspace/orax-desktop run package:win
```

Expected output:

```text
artifacts/orax-desktop/release/Orax-Desktop-<version>-x64-Setup.exe
```

The generated installer is local-only until a signed release pipeline exists.

## Environment

Production sign-in uses:

- `ORAX_API_BASE_URL` for the API base URL, defaulting to `https://www.mustaflow.com`
- Browser approval page: `/orax/desktop-auth/approve`
- Desktop auth routes: `/api/orax/desktop-auth/*`

Do not set `ORAX_DEV_AUTH=true` during production installer smoke tests.

## Code Signing

Unsigned installer builds are acceptable for internal testing only. Public distribution requires:

- Windows code-signing certificate
- Secure certificate storage in CI secrets
- Timestamp server configuration
- Signed installer verification on a clean Windows VM
- Publisher name verified as `MustaFlow AI`

Until signing is configured, the website should show the installer as pending public release or early access only.

## Release Checklist

1. Run `pnpm --filter @workspace/orax-desktop run verify:phase3g`.
2. Build the installer with `pnpm --filter @workspace/orax-desktop run package:win`.
3. Confirm `artifacts/orax-desktop/release/` contains the `.exe`.
4. Install on a clean Windows machine.
5. Start Orax Desktop without `ORAX_DEV_AUTH=true`.
6. Complete browser-approved sign-in.
7. Confirm host registration and heartbeat from Orax web/mobile.
8. Attach a local project folder.
9. Run the desktop-backed Orax smoke flow: inspect files, draft patch, apply patch, verify patch, prepare PR.
10. Confirm no generated installer files are tracked by git.

## Verification

Cross-platform readiness:

```powershell
pnpm --filter @workspace/orax-desktop run verify:phase3g
```

Windows packaging:

```powershell
pnpm --filter @workspace/orax-desktop run package:win
```

Repository guards:

- `artifacts/orax-desktop/release/` must stay ignored.
- Orax installer config must not reference Ora or public-ai.
- No generated installer artifacts should be committed.
