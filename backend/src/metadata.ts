import type { MetadataBag } from './types.js';

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
