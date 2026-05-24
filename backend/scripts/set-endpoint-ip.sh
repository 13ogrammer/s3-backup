#!/usr/bin/env bash
# Update S3_ENDPOINT_URL in backend/.env to the current Mac LAN IP.
# Preserves the existing port. macOS-only (uses `ipconfig getifaddr`).
#
# Usage: npm run set-ip   (or run this script directly)

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
ENV_FILE="$SCRIPT_DIR/../.env"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "error: $ENV_FILE not found" >&2
  exit 1
fi

if ! grep -qE '^S3_ENDPOINT_URL=' "$ENV_FILE"; then
  echo "error: no S3_ENDPOINT_URL= line in $ENV_FILE" >&2
  exit 1
fi

# Try en0 (Wi-Fi on most modern Macs), then en1 (older Macs / Ethernet).
IP=$(ipconfig getifaddr en0 2>/dev/null || true)
if [[ -z "$IP" ]]; then
  IP=$(ipconfig getifaddr en1 2>/dev/null || true)
fi
if [[ -z "$IP" ]]; then
  echo "error: could not determine LAN IP (tried en0, en1)" >&2
  exit 1
fi

CURRENT=$(grep -E '^S3_ENDPOINT_URL=' "$ENV_FILE" | head -n1 | cut -d= -f2-)
PORT=9000
if [[ "$CURRENT" =~ :([0-9]+)/?$ ]]; then
  PORT="${BASH_REMATCH[1]}"
fi

NEW_URL="http://$IP:$PORT"

if [[ "$CURRENT" == "$NEW_URL" ]]; then
  echo "S3_ENDPOINT_URL already $NEW_URL — no change."
  exit 0
fi

sed -i '' -E "s|^S3_ENDPOINT_URL=.*|S3_ENDPOINT_URL=$NEW_URL|" "$ENV_FILE"

echo "S3_ENDPOINT_URL: $CURRENT -> $NEW_URL"
