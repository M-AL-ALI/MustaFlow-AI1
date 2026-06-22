#!/usr/bin/env bash
# register-asc-credentials.sh — Register ASC API key credentials as EAS project
# environment variables so the automatic TestFlight submit job can authenticate
# with App Store Connect without any manual intervention.
#
# Run this ONCE (or after rotating ASC keys) before triggering TestFlight builds.
# It is idempotent: existing variables are updated via --force.
#
# Requires these Replit secrets:
#   EXPO_ASC_KEY_P8      Content of the .p8 file (newlines may be stored as spaces)
#   EXPO_ASC_KEY_ID      10-char key identifier
#   EXPO_ASC_ISSUER_ID   UUID issuer ID
#   Expo_Token           EAS personal access token
#
# After running, the EAS submit job (triggered by --auto-submit in
# build-testflight.sh) will read these from the EAS project environment.

set -euo pipefail

# ── 1. Verify required secrets ────────────────────────────────────────────────
MISSING=0
for var in EXPO_ASC_KEY_P8 EXPO_ASC_KEY_ID EXPO_ASC_ISSUER_ID Expo_Token; do
  if [ -z "${!var:-}" ]; then
    echo "ERROR: \$$var is not set" >&2
    MISSING=1
  fi
done
[ "$MISSING" -eq 1 ] && exit 1

# ── 2. Reconstruct valid PEM from the space-flattened P8 secret ───────────────
P8_CONTENT=$(python3 -c "
import os
raw = os.environ['EXPO_ASC_KEY_P8']
raw = raw.replace('-----BEGIN PRIVATE KEY-----', '').replace('-----END PRIVATE KEY-----', '')
body = '\n'.join(raw.split())
print('-----BEGIN PRIVATE KEY-----')
print(body)
print('-----END PRIVATE KEY-----')
")

# Validate the reconstructed PEM
echo "$P8_CONTENT" | openssl pkey -noout 2>/dev/null || {
  echo "ERROR: reconstructed .p8 key failed openssl validation" >&2
  exit 1
}
echo "ASC key reconstructed and validated."

# ── 3. Move to the mobile workspace ───────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/.."

EAS_CMD="EAS_NO_VCS=1 EXPO_TOKEN=$Expo_Token pnpm dlx eas-cli@latest"

echo ""
echo "Registering ASC credentials as EAS project environment variables ..."
echo "(These are stored as 'sensitive' secrets in the EAS project and never shown in logs)"
echo ""

# ── 4. Register EXPO_ASC_KEY_ID ───────────────────────────────────────────────
echo "  → EXPO_ASC_KEY_ID"
EAS_NO_VCS=1 EXPO_TOKEN="$Expo_Token" \
  pnpm dlx eas-cli@latest env:create \
    --name EXPO_ASC_KEY_ID \
    --value "$EXPO_ASC_KEY_ID" \
    --visibility sensitive \
    --environment production \
    --non-interactive \
    --force \
    2>&1 | grep -v "^$" || true

# ── 5. Register EXPO_ASC_ISSUER_ID ────────────────────────────────────────────
echo "  → EXPO_ASC_ISSUER_ID"
EAS_NO_VCS=1 EXPO_TOKEN="$Expo_Token" \
  pnpm dlx eas-cli@latest env:create \
    --name EXPO_ASC_ISSUER_ID \
    --value "$EXPO_ASC_ISSUER_ID" \
    --visibility sensitive \
    --environment production \
    --non-interactive \
    --force \
    2>&1 | grep -v "^$" || true

# ── 6. Register EXPO_ASC_KEY_P8 (full reconstructed PEM) ─────────────────────
echo "  → EXPO_ASC_KEY_P8"
EAS_NO_VCS=1 EXPO_TOKEN="$Expo_Token" \
  pnpm dlx eas-cli@latest env:create \
    --name EXPO_ASC_KEY_P8 \
    --value "$P8_CONTENT" \
    --visibility sensitive \
    --environment production \
    --non-interactive \
    --force \
    2>&1 | grep -v "^$" || true

echo ""
echo "Done. ASC credentials are now stored in the EAS project environment."
echo "Builds triggered with --auto-submit will submit to TestFlight automatically."
echo ""
echo "Verify via: EXPO_TOKEN=\$Expo_Token pnpm dlx eas-cli@latest env:list --environment production"
