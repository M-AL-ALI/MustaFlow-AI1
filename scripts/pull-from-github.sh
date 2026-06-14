#!/usr/bin/env bash
# Pull latest changes from GitHub (M-AL-ALI/MustaFlow-AI1) and merge into local main.
set -euo pipefail

REMOTE_URL="https://github.com/M-AL-ALI/MustaFlow-AI1.git"
BRANCH="main"

if [ -z "${GITHUB_PAT:-}" ]; then
  echo "ERROR: GITHUB_PAT env var is not set" >&2
  exit 1
fi

GIT_ID=(-c "user.name=${GIT_AUTHOR_NAME:-MustaFlow Agent}" -c "user.email=${GIT_AUTHOR_EMAIL:-agent@mustaflow.app}")
CRED_HELPER='!f() { echo "username=x-access-token"; printf "password=%s\n" "$GITHUB_PAT"; }; f'

# Clear a stale index lock left behind by an interrupted/crashed git process so a
# resolved merge or fetch can proceed. This script is the only git writer here, so
# any pre-existing lock at this point is safe to remove.
rm -f .git/index.lock

# If a merge is already in progress (conflict was manually resolved), complete it first.
if [ -f .git/MERGE_HEAD ]; then
  echo "Completing in-progress merge (conflict resolved) …"
  git add -A
  git "${GIT_ID[@]}" commit --no-edit
fi

echo "Fetching from GitHub MustaFlow-AI1 (forced ref update) …"
git -c credential.helper="$CRED_HELPER" fetch "$REMOTE_URL" "+$BRANCH:refs/remotes/github/$BRANCH"

echo "Merging github/$BRANCH into local $BRANCH …"
git "${GIT_ID[@]}" merge --no-edit "refs/remotes/github/$BRANCH"

echo "Local HEAD is now: $(git rev-parse --short HEAD)"
echo "Done."
