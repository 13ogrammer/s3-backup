import type { MetadataBag } from './types.js';

// Exhaustive list of keys we write in toS3Metadata. Used by fromS3Metadata to
// filter out any unrelated x-amz-meta-* headers the bucket may carry.
const KNOWN_KEYS = new Set<string>([
  'width', 'height', 'createdat', 'make', 'model', 'lens',
  'iso', 'aperture', 'shutter', 'lat', 'lng',
]);

// Map from lowercase S3 key back to MetadataBag field name.
// Note: toS3Metadata lowercases 'createdAt' to 'createdat'.
const KEY_MAP: Record<string, keyof MetadataBag> = {
  width: 'width',
  height: 'height',
  createdat: 'createdAt',
  make: 'make',
  model: 'model',
  lens: 'lens',
  iso: 'iso',
  aperture: 'aperture',
  shutter: 'shutter',
  lat: 'lat',
  lng: 'lng',
};

/**
 * Convert a MetadataBag into a lowercase-keyed Record suitable for the S3
 * SDK's `Metadata` field on PutObjectCommand / CreateMultipartUploadCommand.
 *
 * Rules (S3B-34):
 * - String values are truncated to 100 chars; numeric strings to 20 chars.
 * - Undefined or empty-string values are dropped — S3 writes what is present,
 *   absent fields are not written as empty x-amz-meta-* headers.
 * - Returns undefined when bag is missing or all fields are absent/empty after
 *   truncation, so callers can omit the Metadata field entirely.
 */
/**
 * Inverse of toS3Metadata. Converts the lowercased S3 Metadata record back
 * to a MetadataBag, filtering to only keys we recognise and dropping empty
 * values. Returns undefined when the record is missing or contains no known
 * fields — lets the /head handler omit the metadata field entirely.
 */
export function fromS3Metadata(
  record: Record<string, string> | undefined,
): MetadataBag | undefined {
  if (!record) return undefined;

  const bag: MetadataBag = {};
  for (const [k, v] of Object.entries(record)) {
    const lower = k.toLowerCase();
    if (!KNOWN_KEYS.has(lower)) continue;
    const field = KEY_MAP[lower];
    if (!field || !v) continue;
    bag[field] = v;
  }

  return Object.keys(bag).length > 0 ? bag : undefined;
}

export function toS3Metadata(bag: MetadataBag | undefined): Record<string, string> | undefined {
  if (!bag) return undefined;

  const numericKeys = new Set<keyof MetadataBag>(['iso', 'aperture', 'shutter', 'lat', 'lng', 'width', 'height']);
  const out: Record<string, string> = {};

  for (const [k, v] of Object.entries(bag) as Array<[keyof MetadataBag, string | undefined]>) {
    if (!v) continue;
    const maxLen = numericKeys.has(k) ? 20 : 100;
    const truncated = v.slice(0, maxLen);
    // Lowercase to match metadataBagToHeaders on the client; otherwise the
    // simple-PUT path signs x-amz-meta-createdAt but sends x-amz-meta-createdat
    // and the SigV4 header-name mismatch surfaces as a 400 from S3/MinIO.
    if (truncated) out[k.toLowerCase()] = truncated;
  }

  return Object.keys(out).length > 0 ? out : undefined;
}
