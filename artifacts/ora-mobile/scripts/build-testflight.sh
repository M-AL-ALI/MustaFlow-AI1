#!/usr/bin/env bash
# build-testflight.sh — Non-interactive EAS iOS TestFlight build with automatic submission.
#
# Requires these secrets to be set BEFORE running:
#   EXPO_ASC_KEY_P8      Full content of the .p8 file from App Store Connect
#                        (newlines may be stored as spaces; this script reconstructs valid PEM)
#   EXPO_ASC_KEY_ID      10-char key identifier (e.g. ABCDEF1234)
#   EXPO_ASC_ISSUER_ID   UUID issuer ID from App Store Connect → Keys page
#   EXPO_APPLE_TEAM_ID   10-char Apple Developer Team ID (e.g. AB12345678)
#   EXPO_APPLE_TEAM_TYPE INDIVIDUAL or COMPANY_OR_ORGANIZATION
#
# Also requires:
#   Expo_Token           EAS personal access token (already set)
#
# The --auto-submit flag triggers automatic TestFlight submission after the build
# finishes on EAS servers. Credentials are read from EAS project environment
# variables (EXPO_ASC_KEY_P8, EXPO_ASC_KEY_ID, EXPO_ASC_ISSUER_ID).
# Run scripts/register-asc-credentials.sh once to push those to EAS.
#
# DO NOT commit this file's output. DO NOT print $EXPO_ASC_KEY_P8.
# The .p8 is written to a temp file and erased on exit.

set -euo pipefail

# ── 1. Verify all required secrets are present ────────────────────────────────
MISSING=0
for var in EXPO_ASC_KEY_P8 EXPO_ASC_KEY_ID EXPO_ASC_ISSUER_ID EXPO_APPLE_TEAM_ID EXPO_APPLE_TEAM_TYPE Expo_Token; do
  if [ -z "${!var:-}" ]; then
    echo "ERROR: \$$var is not set" >&2
    MISSING=1
  fi
done
[ "$MISSING" -eq 1 ] && exit 1

echo "All required Apple secrets are present."

# ── 2. Reconstruct valid PEM from the space-flattened P8 secret ───────────────
# The secret may have its internal newlines stored as spaces.
# Strip markers, split body on whitespace, rejoin with newlines, re-wrap.
P8_FILE=$(mktemp /tmp/AuthKey_XXXXXX.p8)
trap 'rm -f "$P8_FILE"' EXIT INT TERM

python3 -c "
import os, sys
raw = os.environ['EXPO_ASC_KEY_P8']
raw = raw.replace('-----BEGIN PRIVATE KEY-----', '').replace('-----END PRIVATE KEY-----', '')
body = '\n'.join(raw.split())
pem = '-----BEGIN PRIVATE KEY-----\n' + body + '\n-----END PRIVATE KEY-----\n'
with open('$P8_FILE', 'w') as f:
    f.write(pem)
"
chmod 600 "$P8_FILE"

# Verify the reconstructed key is valid
if ! openssl pkey -in "$P8_FILE" -noout 2>/dev/null; then
  echo "ERROR: reconstructed .p8 key failed openssl validation" >&2
  exit 1
fi
echo "ASC key reconstructed and validated."

# ── 3. Export the env vars EAS CLI reads for non-interactive Apple auth ────────
export EXPO_ASC_API_KEY_PATH="$P8_FILE"
export EXPO_ASC_KEY_ID="$EXPO_ASC_KEY_ID"
export EXPO_ASC_ISSUER_ID="$EXPO_ASC_ISSUER_ID"
export EXPO_APPLE_TEAM_ID="$EXPO_APPLE_TEAM_ID"
export EXPO_APPLE_TEAM_TYPE="INDIVIDUAL"

# ── 4. Move to the mobile workspace ───────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/.."

# ── 5. Run the EAS build with automatic TestFlight submission ─────────────────
# --auto-submit queues a submit job on EAS servers after the build finishes.
# The submit job reads EXPO_ASC_KEY_P8 / EXPO_ASC_KEY_ID / EXPO_ASC_ISSUER_ID
# from EAS project environment variables (registered via register-asc-credentials.sh).
echo ""
echo "Starting EAS TestFlight build (profile: testflight, platform: ios) ..."
echo "Auto-submit is enabled — the build will be submitted to TestFlight automatically."
EAS_NO_VCS=1 EXPO_TOKEN="$Expo_Token" \
  pnpm dlx eas-cli@latest build \
    --profile testflight \
    --platform ios \
    --non-interactive \
    --auto-submit \
    --no-wait \
    2>&1

echo "Done. Monitor build progress at https://expo.dev/accounts/mus192/projects/mustaflow-ai/builds"
