import { GetObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { classifyKey } from '../mediaType.js';
import { BUCKET, s3, sanitizePrefix } from '../s3.js';
import { THUMB_PREFIX, thumbKey, thumbPrefix } from '../thumbs.js';
import type { ListResponse, ListedFile } from '../types.js';

const PREVIEW_TTL = 60 * 10;

async function listThumbKeys(prefix: string): Promise<Set<string>> {
  const found = new Set<string>();
  let continuationToken: string | undefined;
  do {
    const res = await s3.send(
      new ListObjectsV2Command({
        Bucket: BUCKET,
        Prefix: thumbPrefix(prefix),
        Delimiter: '/',
        ContinuationToken: continuationToken,
      }),
    );
    for (const obj of res.Contents ?? []) {
      if (obj.Key) found.add(obj.Key);
    }
    continuationToken = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (continuationToken);
  return found;
}

export async function list(body: { prefix?: string }): Promise<ListResponse> {
  const prefix = sanitizePrefix(body.prefix);

  const [regular, thumbKeys] = await Promise.all([
    (async () => {
      const folders: string[] = [];
      const files: Array<{ key: string; size: number; lastModified: string }> = [];
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
          if (cp.Prefix && cp.Prefix !== THUMB_PREFIX) folders.push(cp.Prefix);
        }
        for (const obj of res.Contents ?? []) {
          if (!obj.Key || obj.Key === prefix) continue;
          files.push({
            key: obj.Key,
            size: obj.Size ?? 0,
            lastModified: obj.LastModified?.toISOString() ?? '',
          });
        }
        continuationToken = res.IsTruncated ? res.NextContinuationToken : undefined;
      } while (continuationToken);
      return { folders, files };
    })(),
    listThumbKeys(prefix),
  ]);

  const files: ListedFile[] = await Promise.all(
    regular.files.map(async (f) => {
      const kind = classifyKey(f.key);
      let previewUrl: string | undefined;
      if (kind === 'image') {
        const expectedThumb = thumbKey(f.key);
        const urlKey = thumbKeys.has(expectedThumb) ? expectedThumb : f.key;
        previewUrl = await getSignedUrl(
          s3,
          new GetObjectCommand({ Bucket: BUCKET, Key: urlKey }),
          { expiresIn: PREVIEW_TTL },
        );
      }
      return { ...f, kind, previewUrl };
    }),
  );

  return { prefix, folders: regular.folders, files };
}
