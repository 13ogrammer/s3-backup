export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '–';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = bytes / 1024;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u += 1;
  }
  return `${v.toFixed(v >= 10 || u === 0 ? 0 : 1)} ${units[u]}`;
}

export function basename(key: string): string {
  const trimmed = key.replace(/\/$/, '');
  const idx = trimmed.lastIndexOf('/');
  return idx === -1 ? trimmed : trimmed.slice(idx + 1);
}

export function dirname(key: string): string {
  const trimmed = key.replace(/\/$/, '');
  const idx = trimmed.lastIndexOf('/');
  return idx === -1 ? '' : trimmed.slice(0, idx + 1);
}

const IMAGE_EXTS = new Set(['jpg', 'jpeg', 'png', 'heic', 'heif', 'webp', 'gif']);
const VIDEO_EXTS = new Set(['mp4', 'mov', 'm4v', 'avi', 'mkv', 'webm']);

export type DetectedMediaType = 'image' | 'video' | 'other';

export function detectMediaType(filename: string): DetectedMediaType {
  const ext = filename.toLowerCase().split('.').pop() ?? '';
  if (IMAGE_EXTS.has(ext)) return 'image';
  if (VIDEO_EXTS.has(ext)) return 'video';
  return 'other';
}

export function splitPathSegments(prefix: string): string[] {
  if (!prefix) return [];
  return prefix.replace(/\/+$/, '').split('/').filter(Boolean);
}

/** Format decimal-degree lat/lng pair for display. e.g. "37.774929°N, 122.419416°W" */
export function formatGps(lat: string, lng: string): string {
  const latN = parseFloat(lat);
  const lngN = parseFloat(lng);
  if (!Number.isFinite(latN) || !Number.isFinite(lngN)) return `${lat}, ${lng}`;
  const latDir = latN >= 0 ? 'N' : 'S';
  const lngDir = lngN >= 0 ? 'E' : 'W';
  return `${Math.abs(latN).toFixed(6)}°${latDir}, ${Math.abs(lngN).toFixed(6)}°${lngDir}`;
}

/** Format an ISO 8601 date-time string into a locale-friendly short form. */
export function formatDateTaken(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

/**
 * Format a stored aperture string. S3B-34 stores the raw rational as a decimal
 * string (e.g. "1.8"). Renders as "ƒ/1.8".
 */
export function formatAperture(s: string): string {
  return `ƒ/${s}`;
}

/**
 * Format a stored shutter-speed string. S3B-34 stores it as a decimal seconds
 * value (e.g. "0.001"). Renders as a fraction when < 1s (e.g. "1/1000 s"),
 * otherwise as-is with unit.
 */
export function formatShutter(s: string): string {
  const n = parseFloat(s);
  if (!Number.isFinite(n) || n <= 0) return s;
  if (n < 1) {
    const denom = Math.round(1 / n);
    return `1/${denom} s`;
  }
  return `${n} s`;
}

/**
 * Human-readable relative time for the auto-backup status chip.
 * null → 'never'; < 1 min → 'just now'; < 1 hr → 'N min ago';
 * < 24 hr → 'N hr ago'; else → locale date string.
 */
export function formatRelative(ms: number | null): string {
  if (ms === null) return 'never';
  const delta = Date.now() - ms;
  if (delta < 60_000) return 'just now';
  if (delta < 60 * 60_000) return `${Math.floor(delta / 60_000)} min ago`;
  if (delta < 24 * 60 * 60_000) return `${Math.floor(delta / 3_600_000)} hr ago`;
  return new Date(ms).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}
