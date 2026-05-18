/**
 * Metadata builder for S3B-34: capture dimensions / createdAt / GPS at upload
 * time and store as x-amz-meta-* headers on the S3 object.
 *
 * EXIF-only fields (make, model, lens, iso, aperture, shutter) are NOT
 * populated. The original implementation used `exifr`, but its UMD bundle is
 * not Hermes-compatible — it throws "Cannot read property 'includes' of
 * undefined" during module init in the RN runtime. Follow-up card needed to
 * pick a Hermes-friendly parser (or hand-roll a small TIFF/EXIF reader).
 * Until then we ship media-library-sourced fields only:
 *   - width / height          (always present from expo-media-library Asset)
 *   - createdAt               (from Asset.creationTime, epoch ms UTC)
 *   - lat / lng               (from AssetInfo.location when granted)
 */
import type * as MediaLibrary from 'expo-media-library';

import type { MetadataBag } from './api';

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
 * Build a MetadataBag from MediaLibrary asset + assetInfo.
 *
 * @param localUri  Readable file URI — currently unused, kept for future EXIF reintroduction.
 * @param asset     MediaLibrary.Asset from getAssetsAsync
 * @param info      MediaLibrary.AssetInfo from getAssetInfoAsync
 * @param kind      'image' | 'video' | 'other' — currently unused, kept for the
 *                  same reason; the EXIF branch will gate on kind === 'image'.
 */
export async function buildMetadataBag(
  _localUri: string,
  asset: MediaLibrary.Asset,
  info: MediaLibrary.AssetInfo,
  _kind: 'image' | 'video' | 'other',
): Promise<MetadataBag> {
  const bag: MetadataBag = {};

  if (asset.width) bag.width = truncate(asset.width, 20);
  if (asset.height) bag.height = truncate(asset.height, 20);

  if (asset.creationTime) {
    bag.createdAt = normalizeIsoFromEpochMs(asset.creationTime);
  }

  // GPS from AssetInfo.location (available when ACCESS_MEDIA_LOCATION granted
  // on Android; on iOS the CLLocation is returned). Permission denial or no
  // GPS fix leaves info.location null — silently omit lat/lng.
  const loc = (info as { location?: { latitude?: number; longitude?: number } | null }).location;
  if (loc && typeof loc.latitude === 'number' && typeof loc.longitude === 'number') {
    bag.lat = truncate(loc.latitude, 20);
    bag.lng = truncate(loc.longitude, 20);
  }

  return bag;
}
