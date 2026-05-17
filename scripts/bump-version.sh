#!/usr/bin/env bash
#
# Bump the app version in app/app.json. Run before each native release.
#
# Why bump runtimeVersion? app.json has
# `"runtimeVersion": { "policy": "appVersion" }`, so bumping version
# auto-bumps runtimeVersion. Required whenever a new native module is
# added (e.g. installing an expo-* package with a native side), since
# OTA JS to a stale binary would crash on the missing module.
#
# Release notes live on GitHub Releases — write them there after cutting
# the build.

set -euo pipefail

usage() {
  cat <<EOF
Usage: $0 <new-version>

Bumps app/app.json .expo.version.

Arguments:
  <new-version>   Semver MAJOR.MINOR.PATCH (e.g. 1.2.0).

Examples:
  $0 1.2.0
  $0 1.1.1
EOF
}

if [[ $# -lt 1 || "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

NEW_VERSION="$1"

if ! [[ "$NEW_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "Version must be MAJOR.MINOR.PATCH (got: $NEW_VERSION)" >&2
  exit 1
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_JSON="$REPO_ROOT/app/app.json"

[[ -f "$APP_JSON" ]] || { echo "Not found: $APP_JSON" >&2; exit 1; }

CURRENT_VERSION="$(sed -n 's/.*"version": "\([0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*\)".*/\1/p' "$APP_JSON" | head -1)"
if [[ -z "$CURRENT_VERSION" ]]; then
  echo "Could not parse current .expo.version from $APP_JSON" >&2
  exit 1
fi
if [[ "$CURRENT_VERSION" == "$NEW_VERSION" ]]; then
  echo "Already on $NEW_VERSION; nothing to do." >&2
  exit 1
fi
echo "Bumping $CURRENT_VERSION → $NEW_VERSION"

tmp="$(mktemp)"
sed "s/\"version\": \"$CURRENT_VERSION\"/\"version\": \"$NEW_VERSION\"/" "$APP_JSON" > "$tmp"
mv "$tmp" "$APP_JSON"
echo "  ✓ $APP_JSON"

echo
echo "Diff:"
git -C "$REPO_ROOT" --no-pager diff -- "$APP_JSON" || true
echo
echo "Next steps:"
echo "  1) cd app && npx tsc --noEmit"
echo "  2) git add app/app.json && git commit"
echo "  3) Rebuild the dev client (expo run:ios / run:android) so the new"
echo "     runtimeVersion matches the binary you're testing on."
echo "  4) After the new APK is built, draft GitHub Release notes at"
echo "     https://github.com/13ogrammer/s3-backup/releases/new"
