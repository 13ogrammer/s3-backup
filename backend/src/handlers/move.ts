import {
  CopyObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
} from '@aws-sdk/client-s3';
import { classifyKey } from '../mediaType.js';
import { BUCKET, s3, sanitizeKey, sanitizePrefix } from '../s3.js';
import type { MoveRequest, MoveResponse } from '../types.js';

const THUMB_SUFFIX = '.thumb.jpg';

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

export async function move(body: MoveRequest): Promise<MoveResponse> {
  if (body.kind === 'file') {
    const from = sanitizeKey(body.from);
    const to = sanitizeKey(body.to);
    if (from === to) return { moved: 0 };

    await copyAndDelete(from, to);

    if (classifyKey(from) === 'image' && !from.endsWith(THUMB_SUFFIX)) {
      const thumbFrom = `${from}${THUMB_SUFFIX}`;
      const thumbTo = `${to}${THUMB_SUFFIX}`;
      if (await exists(thumbFrom)) {
        await copyAndDelete(thumbFrom, thumbTo);
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

  let moved = 0;
  let continuationToken: string | undefined;

  do {
    const list = await s3.send(
      new ListObjectsV2Command({
        Bucket: BUCKET,
        Prefix: fromPrefix,
        ContinuationToken: continuationToken,
      }),
    );

    const objects = list.Contents ?? [];
    for (const obj of objects) {
      if (!obj.Key) continue;
      const suffix = obj.Key.slice(fromPrefix.length);
      const newKey = toPrefix + suffix;
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

    continuationToken = list.IsTruncated ? list.NextContinuationToken : undefined;
  } while (continuationToken);

  return { moved };
}
