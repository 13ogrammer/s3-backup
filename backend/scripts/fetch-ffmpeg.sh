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
# Expected SHA256 of the .tar.xz archive (release-arm64-static, n7.1.1).
# To refresh after a release bump: curl -sL "$FFMPEG_RELEASE_URL" | shasum -a 256
FFMPEG_SHA256="${FFMPEG_SHA256:-f4149bb2b0784e30e99bdda85471c9b5930d3402014e934a5098b41d0f7201b1}"

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
  # Prefer `sha256sum` (GNU coreutils, Linux default) if present; otherwise fall
  # back to macOS's built-in `shasum -a 256`.
  if command -v sha256sum &>/dev/null; then
    ACTUAL="$(sha256sum "${ARCHIVE}" | awk '{print $1}')"
  elif command -v shasum &>/dev/null; then
    ACTUAL="$(shasum -a 256 "${ARCHIVE}" | awk '{print $1}')"
  else
    echo "ERROR: neither sha256sum nor shasum is available — cannot verify checksum."
    exit 1
  fi
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
# Extract the full archive — the johnvansickle release nests `ffmpeg` inside a
# versioned directory. Avoid GNU-tar-only flags (--wildcards, --strip-components
# matching) so this works under macOS bsdtar as well as GNU tar on Linux.
tar -xJf "${ARCHIVE}" -C "${TMP_DIR}"

# Find the extracted ffmpeg binary (not ffprobe, not ffmpeg.1 manpage).
FFMPEG_SRC="$(find "${TMP_DIR}" -type f -name ffmpeg | head -n 1)"
if [[ -z "${FFMPEG_SRC}" ]]; then
  echo "ERROR: ffmpeg binary not found in extracted archive."
  echo "  Archive may have changed shape — inspect: ${TMP_DIR}"
  trap - EXIT  # leave TMP_DIR around for inspection
  exit 1
fi

mkdir -p "${BIN_DIR}"
cp "${FFMPEG_SRC}" "${DEST}"
chmod +x "${DEST}"

echo ""
echo "ffmpeg ARM64 static binary installed at: ${DEST}"
echo ""
echo "Run 'sam build' (or 'npm run build' in backend/) to bundle it into the Lambda artifact."
