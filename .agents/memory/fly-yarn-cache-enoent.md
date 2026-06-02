---
name: Agentic container yarn cache ENOENT on install
description: yarn v1.22 on Fly machines can have a corrupted .yarn-metadata.json for specific packages (drizzle-orm observed), causing ENOENT on resolution phase → YARN_FAIL exit, even though other packages may install fine.
---

## Rule

When running `yarn install` inside a Fly container exec, yarn may fail with:

```
error Error: ENOENT: no such file or directory, open '/usr/local/share/.cache/yarn/v6/npm-drizzle-orm-...-integrity/node_modules/drizzle-orm/.yarn-metadata.json'
```

This causes the exit code to be non-zero (`YARN_FAIL`), but `node_modules/.bin/tsx` (and other packages) **may still be present** if they were installed before yarn hit the corruption.

**Why:** Yarn v1.22 caches packages globally across invocations. A previous interrupted install can leave a partially-written cache entry. On the next install, yarn tries to read the cached metadata and gets ENOENT, treating the whole install as failed even though the network packages are already in node_modules.

**How to apply:**

1. Before `yarn install`, run `yarn cache clean <pkg>` for known-corrupted packages:
   ```sh
   yarn cache clean drizzle-orm 2>/dev/null; true
   ```
2. After `yarn install` returns (regardless of exit code), **always** check if the target binary exists:
   ```sh
   ls /app/node_modules/.bin/tsx && echo PRESENT || echo MISSING
   ```
   If PRESENT, treat the install as successful even if yarn exited non-zero.
3. Do NOT run npm install AND yarn install concurrently — on 459 MB Fly machines this causes double OOM (both get exit 137). Kill yarn with `pkill -9 -f yarn` before launching npm.
4. If all approaches fail, check `node_modules` package count — partial installs may have enough packages to serve the `/healthz` endpoint (which often has no npm deps).
