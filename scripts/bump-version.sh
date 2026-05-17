#!/usr/bin/env bash
#
# Bump the app version in app/app.json and prepend a new entry to
# app/constants/changelog.ts. Run before each native release.
#
# Why bump runtimeVersion? app.json has
# `"runtimeVersion": { "policy": "appVersion" }`, so bumping version
# auto-bumps runtimeVersion. Required whenever a new native module is
# added (e.g. installing an expo-* package with a native side), since
# OTA JS to a stale binary would crash on the missing module.
#
# Requires: jq.

set -euo pipefail

usage() {
  cat <<EOF
Usage: $0 <new-version> [<note>...]

Bumps app/app.json .expo.version and prepends a CHANGELOG_ENTRIES item.

Arguments:
  <new-version>   Semver MAJOR.MINOR.PATCH (e.g. 1.2.0).
  <note>...       Optional bullets for the changelog entry. If omitted,
                  a TODO placeholder is inserted that you must edit.

Examples:
  $0 1.2.0 "About screen" "Bumped Lambda to 1024MB"
  $0 1.1.1
EOF
}

if [[ $# -lt 1 || "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

NEW_VERSION="$1"
shift
NOTES=("$@")

if ! [[ "$NEW_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "Version must be MAJOR.MINOR.PATCH (got: $NEW_VERSION)" >&2
  exit 1
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_JSON="$REPO_ROOT/app/app.json"
CHANGELOG="$REPO_ROOT/app/constants/changelog.ts"
TODAY="$(date -u +%Y-%m-%d)"

[[ -f "$APP_JSON" ]]  || { echo "Not found: $APP_JSON" >&2; exit 1; }
[[ -f "$CHANGELOG" ]] || { echo "Not found: $CHANGELOG" >&2; exit 1; }

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

# 1) Update app.json — targeted sed preserves the file's hand-formatted layout.
tmp="$(mktemp)"
sed "s/\"version\": \"$CURRENT_VERSION\"/\"version\": \"$NEW_VERSION\"/" "$APP_JSON" > "$tmp"
mv "$tmp" "$APP_JSON"
echo "  ✓ $APP_JSON"

# 2) Write the new changelog entry to a temp file (avoids BSD awk's
#    no-newlines-in-(-v)-vars limitation).
escape_quote() { printf '%s' "$1" | sed "s/'/\\\\'/g"; }
entry_file="$(mktemp)"
{
  printf '  {\n'
  printf "    version: '%s',\n" "$NEW_VERSION"
  printf "    date: '%s',\n" "$TODAY"
  printf '    notes: [\n'
  if [[ ${#NOTES[@]} -eq 0 ]]; then
    printf "      'TODO: describe this release',\n"
  else
    for n in "${NOTES[@]}"; do
      printf "      '%s',\n" "$(escape_quote "$n")"
    done
  fi
  printf '    ],\n'
  printf '  },\n'
} > "$entry_file"

# 3) Inject the entry after the array opener line.
tmp="$(mktemp)"
awk -v entry_file="$entry_file" '
  /^export const CHANGELOG_ENTRIES.*\[$/ {
    print
    while ((getline line < entry_file) > 0) print line
    close(entry_file)
    next
  }
  { print }
' "$CHANGELOG" > "$tmp"
mv "$tmp" "$CHANGELOG"
rm -f "$entry_file"
echo "  ✓ $CHANGELOG"

echo
echo "Diff:"
git -C "$REPO_ROOT" --no-pager diff -- "$APP_JSON" "$CHANGELOG" || true
echo
echo "Next steps:"
echo "  1) Edit the changelog entry if any notes need refinement."
echo "  2) cd app && npx tsc --noEmit"
echo "  3) git add app/app.json app/constants/changelog.ts && git commit"
echo "  4) Rebuild the dev client (expo run:ios / run:android) so the new"
echo "     runtimeVersion matches the binary you're testing on."
