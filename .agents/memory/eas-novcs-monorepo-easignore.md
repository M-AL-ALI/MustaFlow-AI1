---
name: EAS NO_VCS builds in a pnpm monorepo
description: Why EAS_NO_VCS=1 is required for main-agent EAS builds and how .easignore must be tuned, or compression is slow and upload OOM-kills.
---

# EAS iOS builds from the main-agent sandbox (pnpm monorepo)

Four independent blockers stack up; all must be solved together or `eas build` silently never queues.

## 1. Must use `EAS_NO_VCS=1`
Default git-archive mode tries to write `.git/index.lock` (to stash the dirty tree after it bumps `buildNumber`). The main-agent bash sandbox blocks ALL git writes — even `rm .git/index.lock`. So git mode always fails. `EAS_NO_VCS=1` bypasses git entirely. Git mode is unfixable here because autoIncrement always re-dirties the tree.

## 2. `.easignore` REPLACES `.gitignore` — list every heavy dir explicitly
**Why:** When a `.easignore` exists, eas-cli uses it INSTEAD of `.gitignore`. In NO_VCS mode the archive root is the **monorepo root** (cwd), so it walks the whole repo. If `.easignore` only lists `node_modules`, it still copies `.cache/pnpm` (~1.1G) and `attached_assets` (~84M), making "Compressing project files" take 10+ minutes.
**How to apply:** The repo-root `/.easignore` must exclude: `node_modules`, `**/node_modules`, `.cache`, `**/.cache`, `.git`, `.local`, `.agents`, `.expo`, `**/dist`, `**/build`, `**/.turbo`, `**/*.tsbuildinfo`, `attached_assets`, `screenshots`, `docs`, `blueprints`, `scripts/eval-results`, `scripts/benchmark-results`. Verify the staged copy size at `/tmp/runner/eas-cli-nodejs/*-shallow-clone` — should be ~10-25M, not 100M+.

## 3. Large upload silently OOM-kills the detached process
**Why:** With 4 dev-server workflows already running, an ~83M tar upload buffer OOM-kills the eas-cli process mid-upload — NO error in the log, process just vanishes, nothing queues. Shrinking the archive to ~7M tar (exclude `attached_assets` etc.) fixes it.
**How to apply:** Keep the upload tarball small (single-digit MB). Success looks like `- Uploading to EAS Build (0 / 6.9 MB)` then `See logs: https://expo.dev/.../builds/<id>` in the log.

## 4. "Computing project fingerprint" OOM-kills — set `EAS_SKIP_AUTO_FINGERPRINT=1`
**Why:** After a successful upload, eas-cli runs a local "Computing project fingerprint" step that walks/hashes the whole monorepo's native deps. In this sandbox (4 dev workflows running) it OOM-kills silently after several minutes — no error line, process vanishes, build NEVER queues (GraphQL shows no new build). The CLI itself prints the escape hatch: "To skip this step, set the environment variable: EAS_SKIP_AUTO_FINGERPRINT=1".
**How to apply:** Always launch with `EAS_NO_VCS=1 EAS_SKIP_AUTO_FINGERPRINT=1` together. Success then shows `✔ Uploaded to EAS` → `Skipping project fingerprint` → `See logs: https://.../builds/<id>` → `EAS EXIT 0` within ~40s. Fingerprint is only used for build caching; skipping is safe.

## Running a multi-minute eas-cli process in the sandbox
- Foreground bash is killed at 120s OR false-flagged "waiting on user input" on the ora spinner. Don't run eas build in foreground.
- Plain `nohup ... &` children die when the bash tool returns (group kill; nohup ignores SIGHUP not SIGTERM). Use `setsid bash /tmp/script.sh &` where the script opens its own log with `exec >> /tmp/build.log 2>&1` as the FIRST line.
- **Critical:** The launch AND the first log-read (`sleep N && cat log`) must be in the SAME bash tool call, or the log stays empty — the setsid child doesn't reliably write until the parent shell is still alive. Pattern: `setsid bash /tmp/script.sh & sleep 30 && cat /tmp/build.log`. In a subsequent tool call the log may still be frozen at the last TTY-output line (this is normal; the process IS still running).
- Log file stays frozen at "- Compressing project files" or "- Computing project fingerprint" even while working: non-TTY ora spinner updates via `\r` (not written to file). Don't treat a frozen log as a hang — check process aliveness + the staged tar.gz size instead.
- Poll status authoritatively via GraphQL (lightweight), not the log:
  `curl -s -X POST https://api.expo.dev/graphql -H "Authorization: Bearer $Expo_Token" -H "Content-Type: application/json" -d '{"query":"query($appId:String!){app{byId(appId:$appId){builds(limit:3,filter:{platform:IOS}){id status appBuildVersion createdAt}}}}","variables":{"appId":"<projectId>"}}'`
- Auth env: secret is `Expo_Token` (export as `EXPO_TOKEN`). `EXPO_APPLE_TEAM_TYPE=INDIVIDUAL`.
- **More robust than setsid: run the build as a supervised WORKFLOW** (`configureWorkflow` console, command `bash /tmp/eas-build.sh`). setsid children still die here — both sandbox reaping AND periodic container restarts that clear `/tmp` mid-upload (a 7.5M tar with 9.6G free still vanished, so small-tar is necessary but NOT sufficient). A workflow is supervisor-managed and survives.
- **BUT a workflow gives eas-cli a TTY**, so it STOPS at the interactive prompt `? Path to ASC Api Key Path (.p8): ›` and hangs forever (the `--non-interactive` flag does NOT cover this ASC prompt). Fix: redirect the eas-cli command's stdin from `/dev/null` (`eas build ... < /dev/null`) so it detects non-interactive and skips it (same graceful skip the setsid/no-TTY run got). ASC key is not needed for build-only, only for submit.
- **Guard against duplicate costly builds:** end the one-shot script with `; touch /tmp/eas-build-done; sleep infinity` so a "finished" workflow can't auto-restart into a SECOND build; `removeWorkflow` it the moment GraphQL shows the build queued.
- **GraphQL is the source of truth and the EAS build survives local chaos.** Once queued, the build runs on EAS infra — a main-agent container restart that kills the local workflow and wipes `/tmp` does NOT affect the in-progress build. After any restart, just re-query GraphQL; if `appBuildVersion=N` is IN_PROGRESS/FINISHED, the job is fine. Do not relaunch.

## TestFlight submit ASC key
- The EAS credentials service does NOT hold a usable ASC API key (build prompts "Path to ASC Api Key Path (.p8)" non-interactively — non-fatal for build, fatal for `--auto-submit`).
- The `EXPO_ASC_KEY_P8` secret is stored with PEM newlines flattened to **spaces**. Reconstruct valid PEM: strip the `-----BEGIN/END PRIVATE KEY-----` markers, split the remaining body on whitespace, rejoin chunks with `\n`, re-wrap with markers. Verify with `openssl pkey -in file -noout`.
- eas submit env vars: `EXPO_ASC_API_KEY_PATH` (path to the .p8), `EXPO_ASC_KEY_ID`, `EXPO_ASC_ISSUER_ID` (last two already exist as secrets). `eas.json` submit profile carries `ascAppId`.
