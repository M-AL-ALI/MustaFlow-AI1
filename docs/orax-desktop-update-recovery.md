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
- recent Health Action Timeline entries, when exported from the Health page

The exported JSON intentionally excludes:

- session tokens
- passwords
- environment variables
- local project paths
- project file contents
- stdout/stderr
- command output
- secrets

Users can attach this JSON to a MustaFlow support request when installer, sign-in, relay, pairing, or
update issues occur.

## Health Check Panel

Orax Desktop includes a `Health` page in the sidebar. Use it before exporting diagnostics or
escalating a support issue.

The Health Check Panel shows:

- Sign-in status
- Host registration
- Heartbeat status
- Relay polling
- Pairing readiness
- Release channel
- Diagnostics export availability

If any row is blocked, fix that item before asking Orax to run a desktop-backed task. The panel is
designed for user-facing troubleshooting; it does not expose session tokens, local project paths, or
environment variables.

## Health Recovery Actions

Each health row on the Health page includes a contextual action button when the item is not ready.

| Health item        | Button                     | What it does                                                   |
| ------------------ | -------------------------- | -------------------------------------------------------------- |
| Sign-in status     | Sign in again              | Starts the MustaFlow AI sign-in flow and refreshes the session |
| Host registration  | Reconnect host             | Re-registers this computer and refreshes the host state        |
| Relay polling      | Restart relay              | Stops and restarts the relay polling client                    |
| Pairing readiness  | Open pairing               | Navigates directly to the Pairing page                         |
| Release channel    | Check release status       | Confirms the release channel is configured                     |
| Diagnostics export | Export Support Diagnostics | Runs the validated diagnostics export                          |

Recovery action safety rules:

- Actions use only the existing sign-in, host-registration, relay, and pairing flows. No raw Node
  APIs, no shell commands, and no direct environment variable access are exposed to the renderer.
- Errors are redacted before display. Bearer tokens, API keys, private keys, environment variable
  assignments, Windows paths, UNC paths, and Unix paths are replaced with `[redacted]` before any
  error message is rendered.
- The diagnostics export still validates the full payload for sensitive content before writing the
  file. If validation fails, no file is created.
- Action result state (running / success / failed) and last-attempted time are shown inline. State
  is per-session only and is not persisted to disk.

Manual smoke checklist for recovery actions (after install or update):

1. With the desktop signed out, open Health and confirm "Sign in again" appears on the Sign-in row.
2. Click "Sign in again" and complete the sign-in flow; confirm the row turns green.
3. With the host not registered, confirm "Reconnect host" appears and clicking it registers the host.
4. With the relay idle, confirm "Restart relay" appears and clicking it starts relay polling.
5. Confirm "Open pairing" always appears and navigates to the Pairing page.
6. Confirm "Check release status" always appears and shows "Done." after clicking.
7. Confirm "Export Support Diagnostics" always appears and exports a validated JSON file.
8. Confirm no error message displays a token, path, or environment variable string.

## Health Action Timeline

The Health page includes an `Action timeline` below the health rows. It records the latest local
recovery attempts in the current desktop session:

- action label
- running, success, or failed status
- redacted result text
- local timestamp

The timeline is intentionally local UI state. It is not a command log, does not include terminal
output, does not persist across app restarts, and does not include tokens, environment variables, or
local project paths. Use it to quickly confirm what the user already tried before asking for a
support diagnostics export.

When diagnostics are exported from the Health page, the diagnostics payload may include the latest
redacted Health Action Timeline entries. The main process sanitizes and truncates the timeline again
before building the diagnostics JSON. Only action key, action label, running/success/failed status,
redacted message, and timestamp are included. Renderer input is never trusted directly, and the full
diagnostics validator still runs before `writeFile`.

The Health export result shown in the UI must stay high-level:

- Successful export shows `Diagnostics exported. Health timeline included.`
- Cancelled export shows `Diagnostics export cancelled.`
- The Health page must not render the saved local file path, raw diagnostics JSON, or any filesystem
  path returned by the save dialog.
- The Health Action Timeline card shows `Included in diagnostics export from Health.` when timeline
  entries exist and `No timeline entries to include yet.` when it is empty.

Health timeline entries are included only when diagnostics are exported from the Health page.
Settings export may have an empty `healthTimeline` because Settings does not own the Health action history.
Both entry points still build diagnostics in the main process and validate the JSON before it is
written.

## Verification

Repository-safe readiness:

```powershell
pnpm --filter @workspace/orax-desktop run verify:phase3k
```

Stricter diagnostics validation readiness:

```powershell
pnpm --filter @workspace/orax-desktop run verify:phase3l
```

Health panel readiness:

```powershell
pnpm --filter @workspace/orax-desktop run verify:phase3m
```

Health recovery actions readiness:

```powershell
pnpm --filter @workspace/orax-desktop run verify:phase3n
```

Health action timeline readiness:

```powershell
pnpm --filter @workspace/orax-desktop run verify:phase3o
```

Health timeline diagnostics readiness:

```powershell
pnpm --filter @workspace/orax-desktop run verify:phase3p
```

Health diagnostics export result readiness:

```powershell
pnpm --filter @workspace/orax-desktop run verify:phase3q
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
9. Open the Health page and confirm sign-in, host registration, heartbeat, relay polling, pairing
   readiness, release channel, and diagnostics export availability are visible.
10. Exercise each recovery action button and confirm the expected result (sign-in, reconnect,
    restart relay, pairing navigation, release check, diagnostics export).
11. Confirm each recovery action adds a redacted entry to the Action timeline.
12. Export diagnostics from Health and confirm the JSON includes only redacted timeline entries.
13. Confirm the Health page shows `Diagnostics exported. Health timeline included.` after a
    successful export and never displays the saved file path.
14. Cancel the save dialog and confirm the Health page shows `Diagnostics export cancelled.`
