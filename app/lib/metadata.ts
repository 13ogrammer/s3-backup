/**
 * Metadata builder for S3B-34: capture EXIF/dimensions/GPS at upload time
 * and store as x-amz-meta-* headers on the S3 object.
 *
 * Design decisions:
 * - exifr default import (full build) is used instead of the lite subpath
 *   because Metro's resolver does not honour package.json subpath exports for
 *   non-mapped paths. The full build adds ~30 KB gzipped but parses HEIC and
 *   JPEG reliably on Hermes. TODO: try lite if bundle size becomes a concern.
 * - EXIF parse is always wrapped in try/catch — a parse failure is non-fatal;
 *   the upload proceeds with media-library data only.
 * - GPS coordinates are written by default. Permission denial or no fix leaves
 *   info.location null and omits lat/lng silently.
 * - TODO: QA should verify HEIC EXIF on a real iOS device — exifr claims
 *   support but HEIC EXIF extraction has historically been fragile.
 */
import { EncodingType, readAsStringAsync } from 'expo-file-system/legacy';
import type * as MediaLibrary from 'expo-media-library';

import type { MetadataBag } from './api';

// exifr types are not available in @types; the package ships its own .d.ts.
// We use a dynamic import to keep the module lazy (avoid Hermes JIT cost at
// app startup) and to gracefully handle any Metro resolution failure.
type ExifrParseResult = Record<string, unknown> | undefined | null;

async function parseExifFromUri(localUri: string): Promise<ExifrParseResult> {
  // Read the first 64 KB — enough to cover standard EXIF headers in JPEG/HEIC.
  const b64 = await readAsStringAsync(localUri, {
    encoding: EncodingType.Base64,
    length: 65536,
  });
  const bytes = base64ToUint8Array(b64);

  // Dynamic require so Metro can tree-shake if the import ever changes and to
  // avoid a hard startup failure if the module can't be resolved.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const exifr = (require('exifr') as { default?: unknown; parse?: unknown }).default ?? require('exifr');
  if (typeof (exifr as { parse?: unknown }).parse !== 'function') {
    throw new Error('exifr.parse is not a function — check Metro resolution');
  }
  const parse = (exifr as { parse: (input: Uint8Array, opts: unknown) => Promise<ExifrParseResult> }).parse;

  return parse(bytes, {
    tiff: true,
    xmp: false,
    icc: false,
    iptc: false,
    jfif: false,
    ihdr: false,
    gps: true,
    reviveValues: true,
    translateValues: false,
    translateKeys: false,
    sanitize: false,
  });
}

function base64ToUint8Array(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Truncate a value to maxLen characters. Returns undefined for falsy input. */
function truncate(value: string | number | undefined | null, maxLen: number): string | undefined {
  if (value == null || value === '') return undefined;
  return String(value).slice(0, maxLen);
}

/** Epoch milliseconds (from media-library creationTime) → ISO 8601 UTC string. */
export function normalizeIsoFromEpochMs(ms: number): string {
  return new Date(ms).toISOString();
}

/**
 * EXIF DateTimeOriginal → ISO 8601 string.
 *
 * exifr's `reviveValues: true` may return a Date object already. If it returns
 * a string it is in "YYYY:MM:DD HH:MM:SS" format (EXIF standard).
 * When OffsetTimeOriginal is present we append it directly to get a proper
 * ISO 8601 offset datetime; otherwise we treat the naive local string as the
 * device's local time at upload and let JS Date parse it with the engine's
 * timezone applied, then normalise to UTC with toISOString().
 */
export function normalizeIsoFromExif(
  raw: Date | string | undefined | null,
  offsetTime?: string | null,
): string | undefined {
  if (!raw) return undefined;
  try {
    if (raw instanceof Date) {
      // exifr already parsed it
      return raw.toISOString();
    }
    // "YYYY:MM:DD HH:MM:SS" → "YYYY-MM-DDTHH:MM:SS"
    const normalized = raw.replace(/^(\d{4}):(\d{2}):(\d{2})/, '$1-$2-$3').replace(' ', 'T');
    if (offsetTime && /^[+-]\d{2}:\d{2}$/.test(offsetTime.trim())) {
      const isoWithOffset = normalized + offsetTime.trim();
      const d = new Date(isoWithOffset);
      if (!Number.isNaN(d.getTime())) return d.toISOString();
    }
    // No offset — treat as device-local time; JS engine applies local TZ.
    const d = new Date(normalized);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Build a MetadataBag from all available sources.
 *
 * Precedence:
 * 1. EXIF data (parsed from first 64 KB of the file) — most accurate for photos
 * 2. MediaLibrary AssetInfo — always available, used as fallback and for video
 *
 * For video (kind === 'video'): skip EXIF parse entirely. S3B-34 scope only
 * captures width, height, createdAt from MediaLibrary for video assets.
 *
 * @param localUri  Readable file URI (file:// scheme)
 * @param asset     MediaLibrary.Asset from getAssetsAsync
 * @param info      MediaLibrary.AssetInfo from getAssetInfoAsync
 * @param kind      'image' | 'video' | 'other'
 */
export async function buildMetadataBag(
  localUri: string,
  asset: MediaLibrary.Asset,
  info: MediaLibrary.AssetInfo,
  kind: 'image' | 'video' | 'other',
): Promise<MetadataBag> {
  const bag: MetadataBag = {};

  // Width / height from asset (available for both image and video).
  if (asset.width) bag.width = truncate(asset.width, 20);
  if (asset.height) bag.height = truncate(asset.height, 20);

  // createdAt from media-library (available for both image and video).
  if (asset.creationTime) {
    bag.createdAt = normalizeIsoFromEpochMs(asset.creationTime);
  }

  // GPS from AssetInfo.location (available when ACCESS_MEDIA_LOCATION granted
  // on Android; on iOS the CLLocation is returned). Permission denial or no
  // GPS fix leaves info.location null — we silently omit lat/lng.
  const loc = (info as { location?: { latitude?: number; longitude?: number } | null }).location;
  if (loc && typeof loc.latitude === 'number' && typeof loc.longitude === 'number') {
    bag.lat = truncate(loc.latitude, 20);
    bag.lng = truncate(loc.longitude, 20);
  }

  if (kind === 'video') {
    // Videos don't have meaningful EXIF camera data — stop here.
    return bag;
  }

  // EXIF parse for images only.
  try {
    const exif = await parseExifFromUri(localUri);
    if (exif && typeof exif === 'object') {
      const e = exif as Record<string, unknown>;

      // Prefer EXIF DateTimeOriginal + offset over media-library creationTime.
      const dateRaw = e['DateTimeOriginal'] as Date | string | undefined;
      const offset = e['OffsetTimeOriginal'] as string | undefined;
      const exifDate = normalizeIsoFromExif(dateRaw, offset);
      if (exifDate) bag.createdAt = exifDate;

      // EXIF dimensions override asset dimensions when present.
      if (e['ImageWidth']) bag.width = truncate(e['ImageWidth'] as number, 20);
      if (e['ImageHeight']) bag.height = truncate(e['ImageHeight'] as number, 20);
      // Fallback: ExifImageWidth / ExifImageHeight
      if (!bag.width && e['ExifImageWidth']) bag.width = truncate(e['ExifImageWidth'] as number, 20);
      if (!bag.height && e['ExifImageHeight']) bag.height = truncate(e['ExifImageHeight'] as number, 20);

      if (e['Make']) bag.make = truncate(e['Make'] as string, 100);
      if (e['Model']) bag.model = truncate(e['Model'] as string, 100);
      if (e['LensModel']) bag.lens = truncate(e['LensModel'] as string, 100);

      if (e['ISO']) bag.iso = truncate(e['ISO'] as number, 20);

      // Aperture: exifr revives FNumber to a float, e.g. 1.8 → "f/1.8".
      if (e['FNumber']) {
        const f = Number(e['FNumber']);
        if (!Number.isNaN(f)) bag.aperture = truncate(`f/${f.toFixed(1)}`, 20);
      }

      // Shutter speed: ExposureTime as fraction string "1/N" or decimal.
      if (e['ExposureTime']) {
        const t = Number(e['ExposureTime']);
        if (!Number.isNaN(t) && t > 0) {
          const shutter = t < 1 ? `1/${Math.round(1 / t)}` : `${t}`;
          bag.shutter = truncate(shutter, 20);
        }
      }

      // GPS from EXIF (more precise than media-library location in some cases).
      // Only override media-library GPS if EXIF has valid coordinates.
      if (!bag.lat && e['latitude'] && e['longitude']) {
        bag.lat = truncate(e['latitude'] as number, 20);
        bag.lng = truncate(e['longitude'] as number, 20);
      }
    }
  } catch (err) {
    // Non-fatal — proceed with media-library data only. Covers: HEIC without
    // EXIF, corrupt headers, exifr module resolution failure, etc.
    console.warn('[metadata] EXIF parse failed, proceeding with media-library data', err);
  }

  return bag;
}

/**
 * Convert a MetadataBag into HTTP headers for expo-file-system's
 * createUploadTask. The simple-PUT path needs these headers to match exactly
 * what was signed in PutObjectCommand.Metadata — otherwise S3 returns
 * SignatureDoesNotMatch.
 *
 * S3 lowercases x-amz-meta-* header names on the wire. The AWS SDK
 * prefixes each key with "x-amz-meta-" when signing; createUploadTask must
 * send the same prefixed headers so the signature covers them.
 */
export function metadataBagToHeaders(bag: MetadataBag | undefined): Record<string, string> {
  if (!bag) return {};
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(bag)) {
    if (!v) continue;
    headers[`x-amz-meta-${k.toLowerCase()}`] = v;
  }
  return headers;
}
