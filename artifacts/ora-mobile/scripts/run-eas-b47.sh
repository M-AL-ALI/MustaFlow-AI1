#!/usr/bin/env bash
# One-shot wrapper: runs build #47 (documentRefs mobile fix) then parks so the
# workflow can't auto-restart and accidentally queue a second build.
set -euo pipefail

exec >> /tmp/eas-b47.log 2>&1
echo "=== EAS build #47 starting at $(date) ==="

cd "$(dirname "$0")/.."
bash scripts/build-testflight.sh

echo "=== EAS build #47 queued successfully at $(date) ==="
# Park so workflow supervisor never restarts us into a second build.
touch /tmp/eas-b47-done
sleep infinity
