// Thumbnails live in a single top-level folder that mirrors the bucket's
// directory structure. Originals stay where the user put them; thumbs are
// a parallel tree at .thumbnails/ that can be regenerated or wholesale
// deleted without touching real data.
//
//   photos/2025/IMG_001.heic  →  .thumbnails/photos/2025/IMG_001.thumb.jpg
//   IMG_002.jpg               →  .thumbnails/IMG_002.thumb.jpg
//
// The original extension is stripped before appending `.thumb.jpg` so
// the filename reads cleanly. Trade-off: if IMG_001.jpg and IMG_001.heic
// coexist in the same folder, they share one thumb path — rare in
// practice; last-written wins.

export const THUMB_PREFIX = '.thumbnails/';
export const THUMB_EXT = '.thumb.jpg';

export function stripExt(key: string): string {
  const slashIdx = key.lastIndexOf('/');
  const dotIdx = key.lastIndexOf('.');
  if (dotIdx <= slashIdx) return key;
  return key.slice(0, dotIdx);
}

export function thumbKey(originalKey: string): string {
  return `${THUMB_PREFIX}${stripExt(originalKey)}${THUMB_EXT}`;
}

export function thumbPrefix(originalPrefix: string): string {
  return `${THUMB_PREFIX}${originalPrefix}`;
}
