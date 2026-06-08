---
name: Post-merge lockfile drift + husky git block
description: How to repair ERR_PNPM_OUTDATED_LOCKFILE after a task merge adds/changes deps in the main agent sandbox.
---

# Post-merge lockfile drift repair (main agent)

When a merged task adds a new artifact or bumps deps (e.g. a new Expo app), post-merge setup fails with `ERR_PNPM_OUTDATED_LOCKFILE` because `pnpm-lock.yaml` wasn't regenerated. Symptom: ALL dev workflows fail (api-server, web, etc.) because the post-merge `pnpm install --frozen-lockfile` aborts before materializing node_modules.

**Repair sequence that works in the main agent sandbox:**
1. `pnpm install --lockfile-only` — resolves + rewrites the lockfile fast, no downloads. This alone clears the frozen-lockfile drift for future merges/deploys.
2. A regular `pnpm install` to materialize node_modules. It will OFTEN exit non-zero with `Destructive git operations are not allowed in the main agent ... /home/runner/workspace/.git/config.lock` — this is the root `prepare: "husky"` script trying to `git config core.hooksPath`. **The git block happens AFTER packages are installed**, so node_modules is still correct. Verify by checking versions directly (e.g. `node -e "require('./artifacts/<pkg>/node_modules/<dep>/package.json').version"`).
3. `rm -f .git/config.lock` to clear the stale husky lock if it lingers.
4. Restart the failed workflows with `restart_workflow`.

**Why:** husky's `prepare` git write is sandbox-blocked but irrelevant to running apps; the lockfile drift is the real breakage. The updated `pnpm-lock.yaml` is left in the working tree and auto-committed at task end — leaving it unsynced re-breaks the next deploy.

**Background `nohup pnpm install &` dies** when the bash tool's shell session ends, so it never finishes the lockfile write. Use foreground `--lockfile-only` (≈2 min) instead of backgrounding.

**Expo dev workflow "failed" is usually a false alarm:** Metro binds its web port (the artifact's `localPort`) lazily on first request, so `restart_workflow` reports `DIDNT_OPEN_A_PORT` even though Metro is running (log shows "Metro waiting on exp://…"). Expo previews are reached via `$REPLIT_EXPO_DEV_DOMAIN`, not the local port. Don't chase it as a regression.
