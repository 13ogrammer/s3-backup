import {
  CopyObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
} from '@aws-sdk/client-s3';
import { classifyKey } from '../mediaType.js';
import { BUCKET, s3, sanitizeKey, sanitizePrefix } from '../s3.js';
import { thumbKey } from '../thumbs.js';
import { previewKey } from '../previews.js';
import type { MoveFailure, MoveRequest, MoveResponse } from '../types.js';
import type { RequestContext } from '../index.js';

async function copyObject(from: string, to: string): Promise<void> {
  await s3.send(
    new CopyObjectCommand({
      Bucket: BUCKET,
      Key: to,
      CopySource: `/${BUCKET}/${encodeURIComponent(from).replace(/%2F/g, '/')}`,
    }),
  );
}

async function deleteObject(key: string): Promise<void> {
  await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }));
}

async function exists(key: string): Promise<boolean> {
  try {
    await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key }));
    return true;
  } catch {
    return false;
  }
}

/**
 * Moves a single original object and its derived assets atomically at the
 * item level. Throws iff the original copy fails before any state change.
 * If a derived-asset step fails after the original has already been
 * copied+deleted, the error is swallowed: the original is at its new home
 * and derived assets will be regenerated on next view.
 */
async function moveOneObject(fromKey: string, toKey: string): Promise<void> {
  // Copy + delete the original first. If this fails we throw so the caller
  // can mark the item failed without any state change having occurred.
  await copyObject(fromKey, toKey);
  await deleteObject(fromKey);

  // Derived assets are best-effort: failure here does not mark the item
  // failed because the original has already been successfully relocated.
  try {
    const fromKind = classifyKey(fromKey);
    if (fromKind === 'image' || fromKind === 'video') {
      const thumbFrom = thumbKey(fromKey);
      if (await exists(thumbFrom)) {
        await copyObject(thumbFrom, thumbKey(toKey));
        await deleteObject(thumbFrom);
      }
    }
    if (fromKind === 'image') {
      const previewFrom = previewKey(fromKey);
      if (await exists(previewFrom)) {
        await copyObject(previewFrom, previewKey(toKey));
        await deleteObject(previewFrom);
      }
    }
  } catch (err) {
    // Original is at its new home; derived will be regenerated on next view.
    console.warn('[move] derived-asset move failed for', fromKey, err);
  }
}

async function moveTree(
  fromPrefix: string,
  toPrefix: string,
  ctx: RequestContext,
): Promise<{ moved: number; failed: MoveFailure[] }> {
  let moved = 0;
  const failed: MoveFailure[] = [];
  let continuationToken: string | undefined;

  do {
    const res = await s3.send(
      new ListObjectsV2Command({
        Bucket: BUCKET,
        Prefix: fromPrefix,
        ContinuationToken: continuationToken,
      }),
    );
    const objects = res.Contents ?? [];

    for (const obj of objects) {
      if (!obj.Key) continue;
      const newKey = toPrefix + obj.Key.slice(fromPrefix.length);
      try {
        await moveOneObject(obj.Key, newKey);
        moved += 1;
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        ctx.log.warn('moveTree item failed', { key: obj.Key, reason });
        failed.push({ key: obj.Key, reason });
      }
    }

    continuationToken = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (continuationToken);

  return { moved, failed };
}

export async function move(body: MoveRequest, ctx: RequestContext): Promise<MoveResponse> {
  if (body.kind === 'file') {
    const from = sanitizeKey(body.from);
    const to = sanitizeKey(body.to);
    if (from === to) return { moved: 0 };

    try {
      await moveOneObject(from, to);
      ctx.log.info('move', { kind: 'file', from, to });
      return { moved: 1 };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      ctx.log.warn('move file failed', { from, to, reason });
      return { moved: 0, failed: [{ key: from, reason }] };
    }
  }

  const fromPrefix = sanitizePrefix(body.fromPrefix);
  const toPrefix = sanitizePrefix(body.toPrefix);
  if (fromPrefix === '' || toPrefix === '') {
    throw new Error('prefixes must be non-empty for folder move');
  }
  if (fromPrefix === toPrefix) return { moved: 0 };
  if (toPrefix.startsWith(fromPrefix)) {
    throw new Error('cannot move a folder into itself');
  }

  const { moved, failed } = await moveTree(fromPrefix, toPrefix, ctx);
  ctx.log.info('move', { kind: 'folder', fromPrefix, toPrefix, moved, failedCount: failed.length });

  const response: MoveResponse = { moved };
  if (failed.length > 0) response.failed = failed;
  return response;
}
