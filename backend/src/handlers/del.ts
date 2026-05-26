import { DeleteObjectsCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { classifyKey } from '../mediaType.js';
import { invalidateAncestors } from '../folderCountsCache.js';
import { BUCKET, s3, sanitizeKey, sanitizePrefix } from '../s3.js';
import { thumbKey, thumbPrefix } from '../thumbs.js';
import { previewKey, previewPrefix, videoPreviewKey } from '../previews.js';
import type { DeleteRequest, DeleteResponse } from '../types.js';
import type { RequestContext } from '../index.js';

const BATCH_SIZE = 1000;

export async function del(body: DeleteRequest, ctx: RequestContext): Promise<DeleteResponse> {
  const keys = (body.keys ?? []).map(sanitizeKey);
  const prefixes = (body.prefixes ?? []).map((p) => sanitizePrefix(p));

  if (keys.length === 0 && prefixes.length === 0) {
    throw new Error('keys or prefixes must be a non-empty array');
  }

  for (const p of prefixes) {
    if (p === '') throw new Error('prefix must be non-empty');
  }

  const allKeys = new Set<string>(keys);
  for (const k of keys) {
    const kind = classifyKey(k);
    if (kind === 'image' || kind === 'video') {
      allKeys.add(thumbKey(k));
    }
    if (kind === 'image') {
      allKeys.add(previewKey(k));
    }
    // Video previews are generated on-demand as .preview.mp4 by TranscodeWorker.
    if (kind === 'video') {
      allKeys.add(videoPreviewKey(k));
    }
  }

  // For each prefix, also delete the parallel trees under .thumbnails/ and .previews/.
  const expandedPrefixes = [
    ...prefixes,
    ...prefixes.map(thumbPrefix),
    ...prefixes.map(previewPrefix),
  ];

  for (const prefix of expandedPrefixes) {
    let continuationToken: string | undefined;
    do {
      const res = await s3.send(
        new ListObjectsV2Command({
          Bucket: BUCKET,
          Prefix: prefix,
          ContinuationToken: continuationToken,
        }),
      );
      for (const obj of res.Contents ?? []) {
        if (obj.Key) allKeys.add(obj.Key);
      }
      continuationToken = res.IsTruncated ? res.NextContinuationToken : undefined;
    } while (continuationToken);
  }

  const targetKeys = Array.from(allKeys);
  const deleted: string[] = [];
  const errors: DeleteResponse['errors'] = [];

  for (let i = 0; i < targetKeys.length; i += BATCH_SIZE) {
    const batch = targetKeys.slice(i, i + BATCH_SIZE);
    const res = await s3.send(
      new DeleteObjectsCommand({
        Bucket: BUCKET,
        Delete: { Objects: batch.map((Key) => ({ Key })), Quiet: false },
      }),
    );
    for (const d of res.Deleted ?? []) {
      if (d.Key) deleted.push(d.Key);
    }
    for (const e of res.Errors ?? []) {
      if (e.Key) errors.push({ key: e.Key, message: e.Message ?? 'unknown' });
    }
  }

  ctx.log.info('delete', { deletedCount: deleted.length, errorCount: errors.length });

  // Best-effort: evict folder-count cache entries for every affected prefix
  // and each of their ancestors so the next folder-preview reflects the
  // deletion. Failure here never surfaces to the caller.
  try {
    const affectedPrefixes = new Set<string>();
    for (const k of keys) {
      const dir = k.includes('/') ? k.slice(0, k.lastIndexOf('/') + 1) : '';
      if (dir) affectedPrefixes.add(dir);
    }
    for (const p of prefixes) {
      affectedPrefixes.add(p);
    }
    await Promise.allSettled(
      Array.from(affectedPrefixes).map((p) => invalidateAncestors(p)),
    );
  } catch {
    // Swallow — cache invalidation is always best-effort.
  }

  return { deleted, errors };
}
