#!/usr/bin/env bash
# One-shot wrapper: runs build #49 (attach-menu picker modal-dismissal race fix,
# iCloud entitlement reverted) then parks so the workflow can't auto-restart
# and queue a second build.
set -euo pipefail

exec >> /tmp/eas-b49.log 2>&1
echo "=== EAS build #49 starting at $(date) ==="

cd "$(dirname "$0")/.."
bash scripts/build-testflight.sh

echo "=== EAS build #49 queued successfully at $(date) ==="
# Park so workflow supervisor never restarts us into a second build.
touch /tmp/eas-b49-done
sleep infinity
