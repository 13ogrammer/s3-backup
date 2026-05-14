import {
  CopyObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
} from '@aws-sdk/client-s3';
import { classifyKey } from '../mediaType.js';
import { BUCKET, s3, sanitizeKey, sanitizePrefix } from '../s3.js';
import { thumbKey, thumbPrefix } from '../thumbs.js';
import type { MoveRequest, MoveResponse } from '../types.js';

async function copyAndDelete(from: string, to: string): Promise<void> {
  await s3.send(
    new CopyObjectCommand({
      Bucket: BUCKET,
      Key: to,
      CopySource: `/${BUCKET}/${encodeURIComponent(from).replace(/%2F/g, '/')}`,
    }),
  );
  await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: from }));
}

async function exists(key: string): Promise<boolean> {
  try {
    await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key }));
    return true;
  } catch {
    return false;
  }
}

async function moveTree(fromPrefix: string, toPrefix: string): Promise<number> {
  let moved = 0;
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
      await s3.send(
        new CopyObjectCommand({
          Bucket: BUCKET,
          Key: newKey,
          CopySource: `/${BUCKET}/${encodeURIComponent(obj.Key).replace(/%2F/g, '/')}`,
        }),
      );
      moved += 1;
    }
    if (objects.length > 0) {
      await s3.send(
        new DeleteObjectsCommand({
          Bucket: BUCKET,
          Delete: {
            Objects: objects.filter((o) => !!o.Key).map((o) => ({ Key: o.Key! })),
            Quiet: true,
          },
        }),
      );
    }
    continuationToken = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (continuationToken);
  return moved;
}

export async function move(body: MoveRequest): Promise<MoveResponse> {
  if (body.kind === 'file') {
    const from = sanitizeKey(body.from);
    const to = sanitizeKey(body.to);
    if (from === to) return { moved: 0 };

    await copyAndDelete(from, to);

    if (classifyKey(from) === 'image') {
      const thumbFrom = thumbKey(from);
      if (await exists(thumbFrom)) {
        await copyAndDelete(thumbFrom, thumbKey(to));
      }
    }

    return { moved: 1 };
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

  // Move the originals tree, then the parallel thumbs tree.
  const movedOriginals = await moveTree(fromPrefix, toPrefix);
  await moveTree(thumbPrefix(fromPrefix), thumbPrefix(toPrefix));

  return { moved: movedOriginals };
}
