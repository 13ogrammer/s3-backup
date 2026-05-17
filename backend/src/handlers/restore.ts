import {
  DeleteObjectCommand,
  ListObjectVersionsCommand,
} from '@aws-sdk/client-s3';
import { BUCKET, s3, sanitizeKey } from '../s3.js';
import type { RestoreRequest, RestoreResponse } from '../types.js';
import type { RequestContext } from '../index.js';

// Undo a delete by removing the latest delete marker for each key. Only
// works on buckets with versioning enabled (the SAM-managed bucket has
// it on; BYO buckets need to opt in themselves). For un-versioned
// buckets, the previous delete is permanent — the key shows up in
// `missing` and the client surfaces a non-fatal warning.
export async function restore(body: RestoreRequest, ctx: RequestContext): Promise<RestoreResponse> {
  if (!Array.isArray(body.keys) || body.keys.length === 0) {
    throw new Error('keys must be a non-empty array');
  }
  const keys = body.keys.map(sanitizeKey);
  const restored: string[] = [];
  const missing: string[] = [];

  for (const key of keys) {
    const versionId = await findLatestDeleteMarker(key);
    if (!versionId) {
      missing.push(key);
      continue;
    }
    try {
      await s3.send(
        new DeleteObjectCommand({
          Bucket: BUCKET,
          Key: key,
          VersionId: versionId,
        }),
      );
      restored.push(key);
    } catch {
      missing.push(key);
    }
  }

  ctx.log.info('restore', { restoredCount: restored.length, missingCount: missing.length });
  return { restored, missing };
}

async function findLatestDeleteMarker(key: string): Promise<string | null> {
  let keyMarker: string | undefined;
  let versionIdMarker: string | undefined;
  // ListObjectVersions with a key as prefix may return other keys that
  // start with it; we filter to exact matches. Paginate until we find a
  // delete marker for this exact key or run out.
  for (let i = 0; i < 5; i++) {
    const res = await s3.send(
      new ListObjectVersionsCommand({
        Bucket: BUCKET,
        Prefix: key,
        KeyMarker: keyMarker,
        VersionIdMarker: versionIdMarker,
      }),
    );
    for (const marker of res.DeleteMarkers ?? []) {
      if (marker.Key === key && marker.IsLatest && marker.VersionId) {
        return marker.VersionId;
      }
    }
    if (!res.IsTruncated) return null;
    keyMarker = res.NextKeyMarker;
    versionIdMarker = res.NextVersionIdMarker;
  }
  return null;
}
