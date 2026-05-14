import { GetObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { classifyKey } from '../mediaType.js';
import { BUCKET, s3, sanitizePrefix } from '../s3.js';
import type { ListResponse, ListedFile } from '../types.js';

const PREVIEW_TTL = 60 * 10;

export async function list(body: { prefix?: string }): Promise<ListResponse> {
  const prefix = sanitizePrefix(body.prefix);

  const folders: string[] = [];
  const rawFiles: Array<{ key: string; size: number; lastModified: string }> = [];
  let continuationToken: string | undefined;

  do {
    const res = await s3.send(
      new ListObjectsV2Command({
        Bucket: BUCKET,
        Prefix: prefix,
        Delimiter: '/',
        ContinuationToken: continuationToken,
      }),
    );

    for (const cp of res.CommonPrefixes ?? []) {
      if (cp.Prefix) folders.push(cp.Prefix);
    }
    for (const obj of res.Contents ?? []) {
      if (!obj.Key || obj.Key === prefix) continue;
      rawFiles.push({
        key: obj.Key,
        size: obj.Size ?? 0,
        lastModified: obj.LastModified?.toISOString() ?? '',
      });
    }

    continuationToken = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (continuationToken);

  const files: ListedFile[] = await Promise.all(
    rawFiles.map(async (f) => {
      const kind = classifyKey(f.key);
      const previewUrl =
        kind === 'image'
          ? await getSignedUrl(
              s3,
              new GetObjectCommand({ Bucket: BUCKET, Key: f.key }),
              { expiresIn: PREVIEW_TTL },
            )
          : undefined;
      return { ...f, kind, previewUrl };
    }),
  );

  return { prefix, folders, files };
}
