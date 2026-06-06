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

# GitHub occasionally rejects with "cannot lock ref 'refs/heads/main': is at X
# but expected Y" when a concurrent push (e.g. the husky post-commit auto-push
# racing this workflow) updates the ref mid-transaction. It is transient — a
# fresh push that re-reads the current remote tip succeeds. Retry a few times
# with backoff so the race self-heals instead of leaving GitHub stale.
ATTEMPTS=5
for i in $(seq 1 "$ATTEMPTS"); do
  if git \
    -c credential.helper='!f() { echo "username=x-access-token"; printf "password=%s\n" "$GITHUB_PAT"; }; f' \
    push "$REMOTE_URL" "$BRANCH:$BRANCH" $FORCE_FLAG; then
    echo "Done."
    exit 0
  fi
  if [ "$i" -lt "$ATTEMPTS" ]; then
    echo "Push attempt $i/$ATTEMPTS failed (likely a concurrent ref update) — retrying in $((i * 2))s …" >&2
    sleep "$((i * 2))"
  fi
done

echo "ERROR: push to GitHub failed after $ATTEMPTS attempts" >&2
exit 1
