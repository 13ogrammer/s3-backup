#!/usr/bin/env bash
#
# Generate GitHub Release notes from Conventional Commits since the
# last git tag. Wraps git-cliff with the repo's cliff.toml.
#
# Default (no args): commits since the latest tag → stdout.
# Pass any git-cliff flag through, e.g.:
#   ./scripts/release-notes.sh --latest         # only the most recent tag
#   ./scripts/release-notes.sh v1.2.0..HEAD     # explicit range
#
# Typical workflow:
#   ./scripts/bump-version.sh 1.3.0
#   git add app/app.json && git commit -m "chore(app): bump version to 1.3.0"
#   git tag v1.3.0
#   ./scripts/release-notes.sh > /tmp/notes.md
#   gh release create v1.3.0 --notes-file /tmp/notes.md
#
# Requires: git-cliff (brew install git-cliff).

set -euo pipefail

command -v git-cliff >/dev/null 2>&1 || {
  echo "git-cliff not found. Install with: brew install git-cliff" >&2
  exit 1
}

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONFIG="$REPO_ROOT/cliff.toml"

[[ -f "$CONFIG" ]] || { echo "Not found: $CONFIG" >&2; exit 1; }

if [[ $# -eq 0 ]]; then
  exec git-cliff --config "$CONFIG" --unreleased
fi
exec git-cliff --config "$CONFIG" "$@"
