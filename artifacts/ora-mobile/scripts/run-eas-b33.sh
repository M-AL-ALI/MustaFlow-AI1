#!/usr/bin/env bash
# One-shot wrapper: runs build #33 then parks so the workflow can't auto-restart
# and accidentally queue a second build.
set -euo pipefail

exec >> /tmp/eas-b33.log 2>&1
echo "=== EAS build #33 starting at $(date) ==="

cd "$(dirname "$0")/.."
bash scripts/build-testflight.sh

echo "=== EAS build #33 queued successfully at $(date) ==="
# Park so workflow supervisor never restarts us into a second build.
touch /tmp/eas-b33-done
sleep infinity
