---
name: EAS upload silent death + pgrep self-match trap
description: Detached EAS build script can die silently during compression; polling with pgrep -f matches the polling command itself, faking "still running".
---

Two traps when running `setsid bash scripts/build-testflight.sh` detached and polling it:

1. **pgrep self-match**: polling with `pgrep -f build-testflight.sh` from a bash tool call matches the *polling shell itself* (the `bash -c` command line contains the pattern), so it reports "still running" even after the script died. Use `ps aux | grep "[b]racket-trick"` or check log growth / a distinct child process name instead.

2. **Silent compression death**: the EAS CLI can be killed (likely memory pressure from concurrent dev workflows) during "Compressing project files" with NO error line in the log — the log just stops. Recovery:
   - Verify nothing was queued via `eas build:list --json` (latest build ID/number) before retrying — avoids duplicate builds.
   - The failed run already bumped `app.json` buildNumber locally; **reset it to the committed value** before retrying, or autoIncrement lands one higher than intended.
   - Retry when `free -m` shows headroom; the same script typically succeeds in ~2 min (archive ~11 MB with proper .easignore).

**How to apply:** any long-running detached script polled from bash tool calls; any EAS build launched from the Replit main agent.
