#!/usr/bin/env bash
# One-shot wrapper: runs build #54 (Brand Kit mobile parity + Ora chat-path
# diagnostics + website parity hardening — merged from claude/ora-mobile-website-verify)
# then parks so the workflow can't auto-restart and queue a second build.
set -euo pipefail

exec >> /tmp/eas-b54.log 2>&1
echo "=== EAS build #54 starting at $(date) ==="

cd "$(dirname "$0")/.."
bash scripts/build-testflight.sh

echo "=== EAS build #54 queued successfully at $(date) ==="
# Park so workflow supervisor never restarts us into a second build.
touch /tmp/eas-b54-done
sleep infinity
