import {
  CopyObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
} from '@aws-sdk/client-s3';
import { classifyKey } from '../../mediaType.js';
import { BUCKET, s3 } from '../../s3.js';
import { thumbKey } from '../../thumbs.js';
import { previewKey } from '../../previews.js';

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

export async function existsInBucket(key: string): Promise<boolean> {
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
export async function moveOneObject(fromKey: string, toKey: string): Promise<void> {
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
      if (await existsInBucket(thumbFrom)) {
        await copyObject(thumbFrom, thumbKey(toKey));
        await deleteObject(thumbFrom);
      }
    }
    if (fromKind === 'image') {
      const previewFrom = previewKey(fromKey);
      if (await existsInBucket(previewFrom)) {
        await copyObject(previewFrom, previewKey(toKey));
        await deleteObject(previewFrom);
      }
    }
  } catch (err) {
    // Original is at its new home; derived will be regenerated on next view.
    console.warn('[move] derived-asset move failed for', fromKey, err);
  }
}
