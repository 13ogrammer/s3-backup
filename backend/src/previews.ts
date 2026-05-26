// Preview assets live in a parallel tree at .previews/ that mirrors the
// bucket's directory structure. Originals stay where the user put them.
//
//   photos/2025/IMG_001.heic  →  .previews/photos/2025/IMG_001.preview.jpg
//   IMG_002.jpg               →  .previews/IMG_002.preview.jpg
//
// Previews are 1920 px wide (withoutEnlargement) at q=82 — high enough
// quality to serve as in-app full-screen view, small enough to avoid
// downloading the multi-MB original. Sharp generates them on first request
// and caches them here so subsequent opens are a cheap signed-URL GET.
//
// The original extension is stripped before appending `.preview.jpg` so
// the filename reads cleanly. Same trade-off as the thumbnail tree: if
// IMG_001.jpg and IMG_001.heic coexist, they share one preview path.

export const PREVIEW_PREFIX = '.previews/';
export const PREVIEW_EXT = '.preview.jpg';
export const VIDEO_PREVIEW_EXT = '.preview.mp4';

export function previewKey(originalKey: string): string {
  const slashIdx = originalKey.lastIndexOf('/');
  const dotIdx = originalKey.lastIndexOf('.');
  const stripped = dotIdx > slashIdx ? originalKey.slice(0, dotIdx) : originalKey;
  return `${PREVIEW_PREFIX}${stripped}${PREVIEW_EXT}`;
}

/** Returns the `.previews/` path for a video's low-bitrate preview MP4. */
export function videoPreviewKey(originalKey: string): string {
  const slashIdx = originalKey.lastIndexOf('/');
  const dotIdx = originalKey.lastIndexOf('.');
  const stripped = dotIdx > slashIdx ? originalKey.slice(0, dotIdx) : originalKey;
  return `${PREVIEW_PREFIX}${stripped}${VIDEO_PREVIEW_EXT}`;
}

export function previewPrefix(originalPrefix: string): string {
  return `${PREVIEW_PREFIX}${originalPrefix}`;
}
