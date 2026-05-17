#!/usr/bin/env bash
#
# Publish the in-app update manifest to the public release bucket.
# Reads `version` from app/app.json, looks up the release bucket from
# the CloudFormation stack, and uploads a manifest.json the in-app
# update banner will fetch. See docs/DEPLOYMENT.md for context.
#
# Requires: jq, aws CLI configured.

set -euo pipefail

STACK_NAME="${STACK_NAME:-s3-backup}"
APK_URL=""
DRY_RUN=0
ASSUME_YES=0

usage() {
  cat <<EOF
Usage: $0 [--apk-url <url>] [--stack-name <name>] [--dry-run] [--yes]

Flags:
  --apk-url <url>       APK download link from expo.dev. Prompted if omitted.
  --stack-name <name>   CloudFormation stack name (default: s3-backup,
                        or \$STACK_NAME if set).
  --dry-run             Print the manifest and target without uploading.
  --yes, -y             Skip the upload confirmation prompt (non-interactive).
  -h, --help            Show this help.

Examples:
  $0                                          # interactive
  $0 --apk-url https://expo.dev/...
  $0 --apk-url ... --yes                      # fully non-interactive
  $0 --dry-run                                # preview without upload
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --apk-url) APK_URL="${2:-}"; shift 2 ;;
    --stack-name) STACK_NAME="${2:-}"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    --yes|-y) ASSUME_YES=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown flag: $1" >&2; usage; exit 1 ;;
  esac
done

command -v jq >/dev/null 2>&1 || { echo "jq is required (brew install jq)" >&2; exit 1; }
command -v aws >/dev/null 2>&1 || { echo "aws CLI is required" >&2; exit 1; }

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_JSON="$REPO_ROOT/app/app.json"

[[ -f "$APP_JSON" ]] || { echo "Not found: $APP_JSON" >&2; exit 1; }

VERSION="$(jq -r '.expo.version' "$APP_JSON")"
[[ -n "$VERSION" && "$VERSION" != "null" ]] \
  || { echo "Failed to read .expo.version from $APP_JSON" >&2; exit 1; }

echo "App version (from app.json): $VERSION"

if [[ -z "$APK_URL" ]]; then
  read -r -p "APK URL (from expo.dev → Builds → Download): " APK_URL
fi
[[ -n "$APK_URL" ]] || { echo "APK URL is required." >&2; exit 1; }

echo "Looking up release bucket from stack '$STACK_NAME'..."
BUCKET_NAME="$(aws cloudformation describe-stacks \
  --stack-name "$STACK_NAME" \
  --query "Stacks[0].Outputs[?OutputKey=='ReleaseBucketName'].OutputValue" \
  --output text 2>/dev/null || true)"

if [[ -z "$BUCKET_NAME" || "$BUCKET_NAME" == "None" ]]; then
  echo "Could not find ReleaseBucketName in stack $STACK_NAME outputs." >&2
  echo "Was the stack deployed with CreateReleaseBucket=true?" >&2
  exit 1
fi

MANIFEST="$(jq -n \
  --arg version "$VERSION" \
  --arg apk_url "$APK_URL" \
  '{latestNativeVersion: $version, apkUrl: $apk_url}')"

echo
echo "Manifest:"
echo "$MANIFEST"
echo
echo "Target:  s3://$BUCKET_NAME/manifest.json"

if [[ "$DRY_RUN" -eq 1 ]]; then
  echo "(dry run — not uploading)"
  exit 0
fi

if [[ "$ASSUME_YES" -ne 1 ]]; then
  echo
  read -r -p "Upload? [y/N] " CONFIRM
  if [[ "$CONFIRM" != "y" && "$CONFIRM" != "Y" ]]; then
    echo "Aborted."
    exit 0
  fi
fi

TMP_FILE="$(mktemp -t manifest-XXXXXX.json)"
trap 'rm -f "$TMP_FILE"' EXIT
printf '%s' "$MANIFEST" > "$TMP_FILE"

aws s3 cp "$TMP_FILE" "s3://$BUCKET_NAME/manifest.json" \
  --acl bucket-owner-full-control \
  --content-type application/json \
  --cache-control "no-cache, no-store, max-age=0"

echo "Done."
