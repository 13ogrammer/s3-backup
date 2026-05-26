import {
  CopyObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
} from '@aws-sdk/client-s3';
import { classifyKey } from '../../mediaType.js';
import { BUCKET, s3 } from '../../s3.js';
import { thumbKey } from '../../thumbs.js';
import { previewKey, videoPreviewKey } from '../../previews.js';
import type { MergePolicy } from '../../types.js';

export const KEEP_BOTH_CAP = Number(process.env.KEEP_BOTH_CAP ?? 99);

export type MergeOutcome = 'moved' | 'renamed' | 'skipped';

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
  // Pre-check the destination so a collision becomes an explicit per-item
  // failure rather than a silent overwrite. S3 CopyObject would otherwise
  // clobber any existing object at toKey.
  if (await existsInBucket(toKey)) {
    throw new Error('destination already exists');
  }

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
    if (fromKind === 'video') {
      const videoPreviewFrom = videoPreviewKey(fromKey);
      if (await existsInBucket(videoPreviewFrom)) {
        await copyObject(videoPreviewFrom, videoPreviewKey(toKey));
        await deleteObject(videoPreviewFrom);
      }
    }
  } catch (err) {
    // Original is at its new home; derived will be regenerated on next view.
    console.warn('[move] derived-asset move failed for', fromKey, err);
  }
}

/**
 * Finds the first non-colliding key by appending " (n)" before the last
 * extension. Uses LAST `.` so `photo.thumb.jpg` → `photo.thumb (1).jpg`.
 * Extension-less keys just get ` (n)` appended.
 * Throws Error('keep-both-cap-exceeded') if all slots 1..cap are occupied.
 */
async function nextNonCollidingKey(toKey: string, cap: number): Promise<string> {
  const lastDot = toKey.lastIndexOf('.');
  // Only treat a dot as an extension separator when it's after the last slash.
  const lastSlash = toKey.lastIndexOf('/');
  const hasDot = lastDot > lastSlash && lastDot >= 0;
  const base = hasDot ? toKey.slice(0, lastDot) : toKey;
  const ext = hasDot ? toKey.slice(lastDot) : '';

  for (let n = 1; n <= cap; n++) {
    const candidate = `${base} (${n})${ext}`;
    if (!(await existsInBucket(candidate))) return candidate;
  }
  throw new Error('keep-both-cap-exceeded');
}

/**
 * Moves a single object according to the given merge policy:
 *
 *  - replace: copy to toKey (overwrite) + delete from. Derived assets follow.
 *  - skip: if toKey already exists, delete from + derived; otherwise behave
 *    like moveOneObject. Destination untouched on collision.
 *  - keepBoth: if no collision, move normally. On collision, find the next
 *    free " (n)" slot (up to keepBothCap); copy there + delete from. Derived
 *    assets follow to the renamed destination. Throws on cap-exceeded.
 */
export async function mergeOneObject(
  fromKey: string,
  toKey: string,
  policy: MergePolicy,
  options?: { keepBothCap?: number },
): Promise<{ outcome: MergeOutcome; finalKey: string }> {
  const cap = options?.keepBothCap ?? KEEP_BOTH_CAP;

  if (policy === 'replace') {
    // Unconditional overwrite — copy first, then delete source.
    await copyObject(fromKey, toKey);
    await deleteObject(fromKey);
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
      if (fromKind === 'video') {
        const videoPreviewFrom = videoPreviewKey(fromKey);
        if (await existsInBucket(videoPreviewFrom)) {
          await copyObject(videoPreviewFrom, videoPreviewKey(toKey));
          await deleteObject(videoPreviewFrom);
        }
      }
    } catch (err) {
      console.warn('[merge/replace] derived-asset move failed for', fromKey, err);
    }
    return { outcome: 'moved', finalKey: toKey };
  }

  if (policy === 'skip') {
    if (await existsInBucket(toKey)) {
      // Destination exists — drop the source (conflicting key).
      await deleteObject(fromKey);
      try {
        const fromKind = classifyKey(fromKey);
        if (fromKind === 'image' || fromKind === 'video') {
          const thumbFrom = thumbKey(fromKey);
          if (await existsInBucket(thumbFrom)) await deleteObject(thumbFrom);
        }
        if (fromKind === 'image') {
          const previewFrom = previewKey(fromKey);
          if (await existsInBucket(previewFrom)) await deleteObject(previewFrom);
        }
        if (fromKind === 'video') {
          const videoPreviewFrom = videoPreviewKey(fromKey);
          if (await existsInBucket(videoPreviewFrom)) await deleteObject(videoPreviewFrom);
        }
      } catch (err) {
        console.warn('[merge/skip] derived-asset delete failed for', fromKey, err);
      }
      return { outcome: 'skipped', finalKey: toKey };
    }
    // No collision — behave like moveOneObject.
    await moveOneObject(fromKey, toKey);
    return { outcome: 'moved', finalKey: toKey };
  }

  // policy === 'keepBoth'
  if (!(await existsInBucket(toKey))) {
    // No collision — move normally.
    await moveOneObject(fromKey, toKey);
    return { outcome: 'moved', finalKey: toKey };
  }
  // Collision — find next free slot.
  const renamedKey = await nextNonCollidingKey(toKey, cap);
  await copyObject(fromKey, renamedKey);
  await deleteObject(fromKey);
  try {
    const fromKind = classifyKey(fromKey);
    if (fromKind === 'image' || fromKind === 'video') {
      const thumbFrom = thumbKey(fromKey);
      if (await existsInBucket(thumbFrom)) {
        await copyObject(thumbFrom, thumbKey(renamedKey));
        await deleteObject(thumbFrom);
      }
    }
    if (fromKind === 'image') {
      const previewFrom = previewKey(fromKey);
      if (await existsInBucket(previewFrom)) {
        await copyObject(previewFrom, previewKey(renamedKey));
        await deleteObject(previewFrom);
      }
    }
    if (fromKind === 'video') {
      const videoPreviewFrom = videoPreviewKey(fromKey);
      if (await existsInBucket(videoPreviewFrom)) {
        await copyObject(videoPreviewFrom, videoPreviewKey(renamedKey));
        await deleteObject(videoPreviewFrom);
      }
    }
  } catch (err) {
    console.warn('[merge/keepBoth] derived-asset move failed for', fromKey, err);
  }
  return { outcome: 'renamed', finalKey: renamedKey };
}
