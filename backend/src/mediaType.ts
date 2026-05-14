const IMAGE_EXTS = new Set(['jpg', 'jpeg', 'png', 'heic', 'heif', 'webp', 'gif']);
const VIDEO_EXTS = new Set(['mp4', 'mov', 'm4v', 'avi', 'mkv', 'webm']);

export type MediaKind = 'image' | 'video' | 'other';

export function classifyKey(key: string): MediaKind {
  const ext = key.toLowerCase().split('.').pop() ?? '';
  if (IMAGE_EXTS.has(ext)) return 'image';
  if (VIDEO_EXTS.has(ext)) return 'video';
  return 'other';
}
