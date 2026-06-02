---
name: mustaflow-containers Fly proxy required for live preview
description: The live preview proxy depends on a separate Fly app (mustaflow-containers) acting as a reverse proxy to Fly machines. Without it, preview returns 502.
---

## Rule

`livePreviewProxy.ts` proxies `/api/projects/:id/preview/*` to:

```
https://${FLY_APP_NAME}.fly.dev/container/${machineId}
```

(built by `machineProxyUrl()` in `container.ts`)

This target hostname is a **separate Fly.io application** — a reverse-proxy service that routes `/container/:machineId/*` to the appropriate Fly machine's port 3000. It is NOT the Fly machine itself.

**Why:** Fly machines don't get per-machine public HTTP endpoints by default; the proxy app provides a stable URL namespace. The machine's Fly Machines API (`api.machines.dev/v1/...`) is separate and IS reachable regardless of whether the proxy app exists.

**How to apply:**

- If the preview iframe shows HTTP 502 "Couldn't reach the dev server" even though `execInContainer` works and `/healthz` returns 200 via exec, the proxy service is missing or unreachable.
- DNS failure of `${FLY_APP_NAME}.fly.dev` from the Replit environment is the diagnostic signal.
- Fix: deploy the `mustaflow-containers` Fly app (the reverse-proxy worker) and confirm its DNS resolves from wherever the MustaFlow API server runs.
- `FLY_APP_NAME` env var controls the Fly app name; default is `"mustaflow-containers"`.
- The Replit sandbox environment (where `api-server` runs in dev) cannot resolve `mustaflow-containers.fly.dev` — this blocks the live preview proxy in dev mode. A workaround is to run the API server in production (deployed) where the network can reach Fly's edge.
