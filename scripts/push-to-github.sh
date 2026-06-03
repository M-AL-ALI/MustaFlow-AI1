#!/usr/bin/env bash
# Push current main branch to GitHub (M-AL-ALI/MustaFlow-AI1).
# Usage:
#   bash scripts/push-to-github.sh           # normal push (after first sync)
#   bash scripts/push-to-github.sh --force   # force-push (initial sync only)
set -euo pipefail

REMOTE_URL="https://github.com/M-AL-ALI/MustaFlow-AI1.git"
BRANCH="main"
FORCE_FLAG="${1:-}"

if [ -z "${GITHUB_PAT:-}" ]; then
  echo "ERROR: GITHUB_PAT env var is not set — cannot push to GitHub" >&2
  exit 1
fi

echo "Pushing $BRANCH → MustaFlow-AI1 on GitHub $FORCE_FLAG …"

git \
  -c credential.helper='!f() { echo "username=x-access-token"; printf "password=%s\n" "$GITHUB_PAT"; }; f' \
  push "$REMOTE_URL" "$BRANCH:$BRANCH" $FORCE_FLAG

echo "Done."
