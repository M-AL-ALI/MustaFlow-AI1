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

## healthz `containerSubsystem: "error"` linkage (diagnosed 2026-08-04)

- `/healthz` reports a **boot-time cached** result of `runContainerSelfCheck()` (runs once after port bind + migrations); nothing is re-probed per request. Runtime paths gate on `isContainerLayerConfigured()` separately (60 s cache), so runtime behavior self-heals ~60 s after DNS returns — no restart needed; the healthz field only flips on the next instance boot.
- Confirmed root cause: `mustaflow-containers.fly.dev` has NO public A/AAAA records (Cloudflare DoH: NOERROR, empty answer, SOA only) — the proxy Fly app is absent or has no public IPs. The probe's combined log line ("Fly control plane or proxy DNS is unavailable") cannot distinguish DNS vs control-plane/token; DNS alone is sufficient to fail it.
- Impact is fail-closed with fallbacks, by design: agentic container+Neon provisioning skipped at project creation; builder jobs emit `live_server_deferred` and continue file-only; preview serves static DB fallback with banner (`static-fallback`). The terminal path (`execInContainer` → api.machines.dev) does NOT depend on the proxy DNS — only on token validity + an existing machine.
- Config drift found: prod's running deployment has a non-empty FLY_API_TOKEN (probe passed `isConfigured()`, else healthz would say "unconfigured"), but the workspace secret config has NO FLY_API_TOKEN in any scope. A future publish that syncs secrets may flip prod to "unconfigured" — and credential absence + existing containerId triggers stale-container CLEARING in jobs.ts/provisioning.ts.
- The proxy app's source is NOT in this repo; restoring it requires Fly account access (flyctl), outside this workspace.
