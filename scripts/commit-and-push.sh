#!/usr/bin/env bash
# Stage, commit, and push the current working tree to GitHub.
# Used by the agent to persist changes that the bash tool cannot commit
# directly. Safe to run with a clean tree (commit is skipped).
set -euo pipefail

REMOTE_URL="https://github.com/M-AL-ALI/MustaFlow-AI1.git"
BRANCH="main"
MESSAGE="${1:-Cleanup: prettier, Stripe return URLs, setup hardening}"

if [ -z "${GITHUB_PAT:-}" ]; then
  echo "ERROR: GITHUB_PAT env var is not set — cannot push to GitHub" >&2
  exit 1
fi

git add -A

if git diff --cached --quiet; then
  echo "No staged changes — skipping commit."
else
  git -c user.name="Replit Agent" -c user.email="agent@replit.com" \
    commit -m "$MESSAGE"
  echo "Committed: $MESSAGE"
fi

echo "Pushing $BRANCH → MustaFlow-AI1 on GitHub …"
git \
  -c credential.helper='!f() { echo "username=x-access-token"; printf "password=%s\n" "$GITHUB_PAT"; }; f' \
  push "$REMOTE_URL" "$BRANCH:$BRANCH"

echo "HEAD_SHA=$(git rev-parse HEAD)"
echo "Done."
