import { GetObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { classifyKey } from '../mediaType.js';
import { BUCKET, s3, sanitizePrefix } from '../s3.js';
import { THUMB_PREFIX, thumbKey, thumbPrefix } from '../thumbs.js';
import type { ListRequest, ListResponse, ListedFile } from '../types.js';

const PREVIEW_TTL = 60 * 10;
const PAGE_SIZE = 500;

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

export async function list(body: ListRequest): Promise<ListResponse> {
  const prefix = sanitizePrefix(body.prefix);

  const [pageRes, thumbKeys] = await Promise.all([
    s3.send(
      new ListObjectsV2Command({
        Bucket: BUCKET,
        Prefix: prefix,
        Delimiter: '/',
        ContinuationToken: body.continuationToken,
        MaxKeys: PAGE_SIZE,
      }),
    ),
    listThumbKeys(prefix),
  ]);

  const folders: string[] = [];
  for (const cp of pageRes.CommonPrefixes ?? []) {
    if (cp.Prefix && cp.Prefix !== THUMB_PREFIX) folders.push(cp.Prefix);
  }

  const rawFiles: Array<{ key: string; size: number; lastModified: string }> = [];
  for (const obj of pageRes.Contents ?? []) {
    if (!obj.Key || obj.Key === prefix) continue;
    rawFiles.push({
      key: obj.Key,
      size: obj.Size ?? 0,
      lastModified: obj.LastModified?.toISOString() ?? '',
    });
  }

  const files: ListedFile[] = await Promise.all(
    rawFiles.map(async (f) => {
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
      } else if (kind === 'video') {
        // Videos have a thumb sidecar but no useful fallback (the
        // original is video bytes, not a still). If no thumb exists,
        // leave previewUrl undefined and let the client render a
        // placeholder tile.
        const expectedThumb = thumbKey(f.key);
        if (thumbKeys.has(expectedThumb)) {
          previewUrl = await getSignedUrl(
            s3,
            new GetObjectCommand({ Bucket: BUCKET, Key: expectedThumb }),
            { expiresIn: PREVIEW_TTL },
          );
        }
      }
      return { ...f, kind, previewUrl };
    }),
  );

  return {
    prefix,
    folders,
    files,
    nextToken: pageRes.IsTruncated ? pageRes.NextContinuationToken : undefined,
  };
}
