import { DeleteObjectsCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { classifyKey } from '../mediaType.js';
import { BUCKET, s3, sanitizeKey, sanitizePrefix } from '../s3.js';
import { thumbKey, thumbPrefix } from '../thumbs.js';
import { previewKey, previewPrefix } from '../previews.js';
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
    // Preview assets are only generated for images.
    if (kind === 'image') {
      allKeys.add(previewKey(k));
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
  return { deleted, errors };
}
