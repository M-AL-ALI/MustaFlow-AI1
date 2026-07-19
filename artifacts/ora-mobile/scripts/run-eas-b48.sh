#!/usr/bin/env bash
# One-shot wrapper: runs build #48 (iCloud Documents entitlement for the file
# picker) then parks so the workflow can't auto-restart and queue a second build.
set -euo pipefail

exec >> /tmp/eas-b48.log 2>&1
echo "=== EAS build #48 starting at $(date) ==="

cd "$(dirname "$0")/.."
bash scripts/build-testflight.sh

echo "=== EAS build #48 queued successfully at $(date) ==="
# Park so workflow supervisor never restarts us into a second build.
touch /tmp/eas-b48-done
sleep infinity
