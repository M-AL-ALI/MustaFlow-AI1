# Orax Desktop End-to-End Smoke Test

Last updated: 2026-07-05

This runbook verifies the Orax desktop-backed agent loop on Windows. It is intentionally written as a user-flow smoke test, not a unit-test checklist.

## Scope

Verify that Orax can move through the real Codex-style path:

1. Open Orax Desktop.
2. Sign in/register the desktop host.
3. Pair website/mobile surfaces to the host.
4. Attach a local project folder.
5. Start an Orax project thread from the web workspace.
6. Inspect/read relevant files.
7. Draft a patch.
8. Apply the patch after approval.
9. Verify the patch.
10. Draft a fix if verification fails.
11. Prepare a GitHub PR.
12. Confirm mobile can observe the same project thread events.

Do not include Ora/public-ai chat in this smoke test. Orax must remain separate from Ora.

## Preconditions

- Windows desktop with PowerShell available.
- Git installed and available on PATH.
- Node and pnpm installed.
- A test GitHub repository with a non-production branch or disposable clone.
- MustaFlow account available for Orax auth.
- Orax Desktop build available from `artifacts/orax-desktop`.
- Website/API server environment running.
- Mobile app or mobile web preview available for observation.
- Optional: `GITHUB_TOKEN` or `GH_TOKEN` set on the desktop if real PR creation is expected.

## Automated Readiness Gate

Run from the repository root:

```powershell
pnpm --filter @workspace/orax-desktop run verify:phase3d
pnpm --filter @workspace/mustaflow run test -- src/lib/__tests__/orax-wiring.test.ts
```

Expected:

- Desktop typecheck passes.
- Desktop build passes.
- `smoke:readiness` passes.
- Orax wiring tests pass.

## Manual Smoke Flow

### 1. Open Orax Desktop

Run:

```powershell
pnpm --filter @workspace/orax-desktop run dev
```

Expected:

- App opens without a renderer crash.
- First-run flow shows `Welcome to Orax`.
- The copy explains that Orax works with projects on this computer after approval.
- No password field is shown inside the desktop app.

### 2. Register Host

Complete the desktop sign-in/register flow.

Expected:

- Desktop status becomes `Online`.
- Host name, platform, permission mode, app version, and host ID are visible.
- Relay card shows active/idle state without an error.

### 3. Pair Device

Open the Pairing screen and generate a pairing code.

Expected:

- Pairing code is account-bound and single-use.
- QR/manual pairing payload is visible.
- Website/mobile can redeem the code.
- Revoked devices no longer appear trusted.

### 4. Website Orax Card

Open the MustaFlow website mode/home screen.

Expected:

- If no host is registered: Orax card shows `Setup required` and opens the product/download page.
- If host exists but offline: Orax card shows `Desktop offline` and opens devices.
- If host is online: Orax card shows `Desktop online` and opens the Orax workspace.

### 5. Attach Project Source

In Orax Desktop, open Projects and attach a local folder to an Orax cloud project.

Expected:

- Cloud project appears.
- Local source appears.
- `.orax/project.json` is written only inside the selected folder.
- Missing local folders show as missing/reconnect, not active.

### 6. Start Thread

In website Orax workspace, open the project and create a thread.

Prompt example:

```text
Review the login flow and make a small safe improvement.
```

Expected:

- Thread message appears inline.
- Desktop receives a `run_project_thread` action.
- Thread shows project inspection result.
- Thread shows selected/read file list.

### 7. Draft Patch

Continue the thread until Orax drafts a patch.

Expected:

- Website shows `project_patch_drafted`.
- Patch card includes changed file chips, diff preview, risks, and verification plan.
- No raw JSON/action ID is visible in the normal thread.
- Mobile shows the corresponding compact patch card.

### 8. Apply Patch

Click `Apply patch`.

Expected:

- Desktop creates `.orax/checkpoints/<threadId>/<timestamp>/`.
- Only intended Orax-changed files are written.
- Blocked files and outside-root paths are rejected.
- Website shows `project_patch_applied` or `project_patch_failed`.

### 9. Verify Patch

After apply succeeds, Orax should queue verification.

Expected:

- Desktop runs only allowlisted safe checks.
- Website shows `project_patch_verified` when checks pass.
- Website shows `project_patch_verification_failed` when checks fail.
- Mobile shows the same verification result compactly.

### 10. Prepare Fix

If verification fails, click `Prepare fix`.

Expected:

- Orax uses failed check output to draft a targeted fix.
- Website shows `project_fix_drafted`.
- `Apply fix` reuses the approval-gated apply path.
- No writes occur before user approval.

### 11. Prepare Pull Request

After verification passes, click `Create pull request`.

Expected:

- Orax creates an `orax/<threadId8>/<slug>` branch.
- Orax commits only the changed files from its patch/apply context.
- If GitHub auth is available, Orax creates a real PR and shows `project_pr_ready`.
- If GitHub auth/remote is missing, Orax shows `project_pr_blocked` with a clear next step.
- No force-push, hard reset, or clean command is used.

### 12. Production Sign-In

Start Orax Desktop without `ORAX_DEV_AUTH=true`.

Expected:

- Clicking **Sign in with MustaFlow** opens `/orax/desktop-auth/approve` in the browser.
- The browser page asks the signed-in MustaFlow user to approve the desktop code.
- After approval, Orax Desktop finishes sign-in automatically and registers the host.
- No password is typed into Orax Desktop.
- The stored token only authenticates `/api/orax/*` routes.

### 13. Mobile Observation

Open Orax mobile.

Expected:

- The same project/thread status is visible.
- Mobile cards show patch, verification, fix, and PR states.
- Mobile does not create a separate Ora conversation for this work.

## Pass Criteria

The smoke test passes when a user can complete the desktop-backed flow from setup to PR-ready/blocked without using dashboard-only controls or developer-only scripts.

## Known Gaps After Phase 3D

- Installer packaging/signing is not production-ready.
- Browser-approved Orax Desktop sign-in is available; installer packaging/signing is still pending.
- Real GitHub PR creation needs a valid token or authenticated git credentials.
- Mobile is a remote-control observer/controller, not a remote desktop stream.
- Billing/usage accounting for Orax execution still needs a dedicated pass.
