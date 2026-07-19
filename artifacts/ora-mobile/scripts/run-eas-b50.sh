#!/usr/bin/env bash
# One-shot wrapper: runs build #50 (silent expired-session recovery on Ora
# sends — ChatGPT-like resume after 30+ min idle) then parks so the workflow
# can't auto-restart and queue a second build.
set -euo pipefail

exec >> /tmp/eas-b50.log 2>&1
echo "=== EAS build #50 starting at $(date) ==="

cd "$(dirname "$0")/.."
bash scripts/build-testflight.sh

echo "=== EAS build #50 queued successfully at $(date) ==="
# Park so workflow supervisor never restarts us into a second build.
touch /tmp/eas-b50-done
sleep infinity
