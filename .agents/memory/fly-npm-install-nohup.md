---
name: Fly container npm install — sync OOM-kills, nohup succeeds
description: Why synchronous npm install fails in Fly exec and how the background nohup approach fixes it, plus the 429 double-exec race.
---

## Rule

Never run `npm install` synchronously inside a Fly.io exec call. Always use the nohup-background-then-poll pattern.

**Why:** When `npm install` runs as a direct child of a Fly exec shell, the V8 heap pressure from both the exec shim process and npm's resolver exceeds the container's OOM limit, killing npm with exit 137 ("Killed") — even for a single package. When run via `nohup sh -c '... npm install ...' &`, npm is the only node process competing for RAM and succeeds reliably.

**Why (429 double-exec):** `flyFetch` retries on HTTP 429. If the first exec request reached the container and started a `nohup npm install` before being rate-limited, the retry starts a _second_ concurrent npm install. Two concurrent npm installs always OOM on these containers.

**How to apply:**

- `npmInstallInBackground` in `container.ts` is the correct call site. It already uses nohup + poll.
- The launch command must start with `pkill -f 'npm install' 2>/dev/null; sleep 1;` so that any previous npm process (from a 429-triggered retry) is killed before starting a fresh one.
- For one-off fix scripts: use synchronous npm install only for individual packages as a _probe_ to check if it works fast (unlikely) — expect OOM, then fall back to nohup approach.
- Yarn v1.22 (at `/usr/local/bin/yarn`) is present in container images and can serve as an alternative; combining yarn's parallel fetch with a follow-up `npm install` (which then sees packages already on disk and exits "up to date in 25s") is a reliable two-step pattern.
