#!/usr/bin/env bash
# Downloads the static ARM64 ffmpeg binary from johnvansickle.com and places it
# at backend/bin/ffmpeg-arm64. This binary is gitignored and must be present
# before running `sam build` (the Makefile's build-TranscodeWorker target copies
# it into the Lambda artifact as bin/ffmpeg).
#
# GPL notice: the static ffmpeg build from johnvansickle.com is licensed under
# the GNU GPL v2. Acceptable for this self-hosted BYO-AWS deployment model —
# the binary is not distributed to end users; it runs inside your own Lambda.
#
# Usage:
#   bash backend/scripts/fetch-ffmpeg.sh
#
# Environment variables:
#   FFMPEG_RELEASE_URL  Override the download URL (advanced).
#   FFMPEG_SHA256       Override the expected SHA256 checksum (advanced).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
BIN_DIR="${REPO_ROOT}/backend/bin"
DEST="${BIN_DIR}/ffmpeg-arm64"

# johnvansickle.com static ARM64 build (n7.1.1-static).
# Update these when upgrading ffmpeg.
FFMPEG_RELEASE_URL="${FFMPEG_RELEASE_URL:-https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-arm64-static.tar.xz}"
# Expected SHA256 of the .tar.xz archive.
# To refresh: curl -sL "$FFMPEG_RELEASE_URL" | sha256sum
FFMPEG_SHA256="${FFMPEG_SHA256:-}"

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

echo "Downloading ffmpeg ARM64 static binary..."
echo "  URL: ${FFMPEG_RELEASE_URL}"

if ! command -v curl &>/dev/null; then
  echo "ERROR: curl is required. Install it and re-run this script."
  exit 1
fi

ARCHIVE="${TMP_DIR}/ffmpeg.tar.xz"
curl --fail --location --progress-bar --output "${ARCHIVE}" "${FFMPEG_RELEASE_URL}"

if [[ -n "${FFMPEG_SHA256}" ]]; then
  echo "Verifying checksum..."
  ACTUAL="$(sha256sum "${ARCHIVE}" | awk '{print $1}')"
  if [[ "${ACTUAL}" != "${FFMPEG_SHA256}" ]]; then
    echo "ERROR: SHA256 mismatch!"
    echo "  Expected: ${FFMPEG_SHA256}"
    echo "  Got:      ${ACTUAL}"
    echo "If you are intentionally updating ffmpeg, update FFMPEG_SHA256 in this script."
    exit 1
  fi
  echo "Checksum OK."
else
  echo "WARNING: FFMPEG_SHA256 not set — skipping checksum verification."
  echo "  Compute and embed it in this script for reproducible builds."
fi

echo "Extracting binary..."
tar -xJf "${ARCHIVE}" -C "${TMP_DIR}" --wildcards '*/ffmpeg' --strip-components=1

mkdir -p "${BIN_DIR}"
cp "${TMP_DIR}/ffmpeg" "${DEST}"
chmod +x "${DEST}"

echo ""
echo "ffmpeg ARM64 static binary installed at: ${DEST}"
echo ""
echo "Run 'sam build' (or 'npm run build' in backend/) to bundle it into the Lambda artifact."
