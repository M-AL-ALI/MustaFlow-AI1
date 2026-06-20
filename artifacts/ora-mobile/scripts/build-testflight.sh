#!/usr/bin/env bash
# build-testflight.sh — Non-interactive EAS iOS TestFlight build.
#
# Requires these 5 Replit secrets to be set BEFORE running:
#   EXPO_ASC_KEY_P8      Full content of the .p8 file from App Store Connect
#   EXPO_ASC_KEY_ID      10-char key identifier (e.g. ABCDEF1234)
#   EXPO_ASC_ISSUER_ID   UUID issuer ID from App Store Connect → Keys page
#   EXPO_APPLE_TEAM_ID   10-char Apple Developer Team ID (e.g. AB12345678)
#   EXPO_APPLE_TEAM_TYPE INDIVIDUAL or COMPANY_OR_ORGANIZATION
#
# Also requires:
#   Expo_Token           EAS personal access token (already set)
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

echo "All required secrets present."
echo "  Key ID:      $EXPO_ASC_KEY_ID"
echo "  Issuer ID:   $EXPO_ASC_ISSUER_ID"
echo "  Team ID:     $EXPO_APPLE_TEAM_ID"
echo "  Team type:   $EXPO_APPLE_TEAM_TYPE"
echo "  .p8 length:  $(echo -n "$EXPO_ASC_KEY_P8" | wc -c) bytes"

# ── 2. Write .p8 to a temp file; erase on exit ────────────────────────────────
P8_FILE=$(mktemp /tmp/AuthKey_XXXXXX.p8)
trap 'rm -f "$P8_FILE"' EXIT INT TERM

printf '%s' "$EXPO_ASC_KEY_P8" > "$P8_FILE"
chmod 600 "$P8_FILE"
echo "Wrote .p8 to $P8_FILE"

# ── 3. Export the env vars EAS CLI reads for non-interactive Apple auth ────────
export EXPO_ASC_API_KEY_PATH="$P8_FILE"
export EXPO_ASC_KEY_ID="$EXPO_ASC_KEY_ID"
export EXPO_ASC_ISSUER_ID="$EXPO_ASC_ISSUER_ID"
export EXPO_APPLE_TEAM_ID="$EXPO_APPLE_TEAM_ID"
export EXPO_APPLE_TEAM_TYPE="$EXPO_APPLE_TEAM_TYPE"

# ── 4. Move to the mobile workspace ───────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/.."

# ── 5. Run the EAS build ───────────────────────────────────────────────────────
echo ""
echo "Starting EAS TestFlight build (profile: testflight, platform: ios) ..."
EAS_NO_VCS=1 EXPO_TOKEN="$Expo_Token" \
  timeout 120 pnpm dlx eas-cli@latest build \
    --profile testflight \
    --platform ios \
    --non-interactive \
    2>&1

echo "Done."
