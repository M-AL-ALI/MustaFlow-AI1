# Orax Desktop Update and Recovery

This runbook covers Orax Desktop update behavior, failed update recovery, rollback, and support
diagnostics. It is scoped to Orax Desktop only. Do not include Ora/public-ai chat, AI Builder, or
mobile Ora assistant behavior in this flow.

## Current Update Model

Orax Desktop uses the signed release channel defined in
`docs/orax-desktop-release-channel.md`.

The production-safe path is:

1. Build and sign the Windows installer.
2. Generate `orax-desktop-windows-latest.json`.
3. Upload installer artifacts and manifest to the controlled download host.
4. Keep the website public download switch off until smoke testing passes.
5. Enable `VITE_ORAX_DESKTOP_PUBLIC_DOWNLOAD_ENABLED=true` only after the manifest validates.

The desktop app does not silently install updates in the background yet. Users install the signed
Windows build from the controlled Orax Desktop download channel. This avoids surprise updates while
desktop execution is still being hardened.

## Failed Update Recovery

If an update fails:

1. Keep the existing installed version available.
2. Do not advance the public latest manifest.
3. Keep the failed installer and manifest internal for investigation.
4. Ask the user to export Support Diagnostics from Orax Desktop Settings.
5. Confirm whether sign-in, host registration, heartbeat, pairing, and relay polling still work.
6. If the app cannot open, ask the user to reinstall the last known-good signed installer.

Do not ask users to delete local project folders or `.orax/project.json` bindings unless support has
confirmed a project binding mismatch. Project data and checkpoints must remain user-controlled.

## Rollback

Rollback means moving the public latest manifest back to the last known-good signed release.

Rollback checklist:

1. Confirm the previous installer is still available on the download host.
2. Restore the previous `latest.yml`.
3. Restore the previous `orax-desktop-windows-latest.json`.
4. Keep the website public download switch enabled only if the restored manifest validates.
5. Announce the rollback internally with the failed version, restored version, and reason.
6. Verify clean Windows install, production sign-in, host heartbeat, pairing, and a small Orax task.

## Support Diagnostics

Orax Desktop Settings includes `Export Support Diagnostics`.

The diagnostics payload is validated before it is written to disk. If validation detects a bearer
token, API key, private key, password-like value, environment assignment, or absolute local path, the
export fails and no diagnostics file is created.

The exported JSON includes:

- Orax Desktop version
- Electron version
- platform and architecture
- signed-in user id and email
- host state
- relay state
- local project count and display names

The exported JSON intentionally excludes:

- session tokens
- passwords
- environment variables
- local project paths
- project file contents
- secrets

Users can attach this JSON to a MustaFlow support request when installer, sign-in, relay, pairing, or
update issues occur.

## Verification

Repository-safe readiness:

```powershell
pnpm --filter @workspace/orax-desktop run verify:phase3k
```

Stricter diagnostics validation readiness:

```powershell
pnpm --filter @workspace/orax-desktop run verify:phase3l
```

Manual smoke after any update:

1. Install the signed build on a clean Windows machine.
2. Sign in through MustaFlow AI.
3. Confirm Orax Desktop registers a host and heartbeats.
4. Pair web or mobile.
5. Attach a small local project.
6. Run a small Orax task.
7. Export Support Diagnostics and confirm the file contains no token, password, environment variable,
   or local path.
8. Confirm a forced unsafe diagnostics payload is rejected before `writeFile`.
