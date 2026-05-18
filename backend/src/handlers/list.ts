// /list returns previewUrl only when a cached thumbnail already exists in
// .thumbnails/. If no thumb is present for an image key, previewUrl is
// omitted — the Browse tab calls /get-derived-url to generate and cache
// the thumb on demand. This is a one-way change: clients from before this
// update that relied on the original-image fallback will briefly show a
// placeholder for un-backfilled images until the on-demand path warms the
// cache. Buckets that ran backfill-thumbnails.ts are unaffected.
import { GetObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { classifyKey } from '../mediaType.js';
import { BUCKET, s3, sanitizePrefix } from '../s3.js';
import { PREVIEW_PREFIX } from '../previews.js';
import { THUMB_PREFIX, thumbKey, thumbPrefix } from '../thumbs.js';
import type { ListRequest, ListResponse, ListedFile } from '../types.js';
import type { RequestContext } from '../index.js';

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

// Single-part ETags are exactly 32 lowercase hex characters.
// Multipart ETags include a "-N" suffix and are excluded by this check.
const SINGLE_PART_ETAG_RE = /^[a-f0-9]{32}$/i;

function parseEtag(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const stripped = raw.replace(/^"|"$/g, '');
  return SINGLE_PART_ETAG_RE.test(stripped) ? stripped.toLowerCase() : undefined;
}

export async function list(body: ListRequest, ctx: RequestContext): Promise<ListResponse> {
  const prefix = sanitizePrefix(body.prefix);
  const recursive = body.recursive === true;

  if (recursive) {
    // Recursive scan: no Delimiter, skip derived-asset prefixes, no thumb pre-warming.
    const pageRes = await s3.send(
      new ListObjectsV2Command({
        Bucket: BUCKET,
        Prefix: prefix,
        ContinuationToken: body.continuationToken,
        MaxKeys: PAGE_SIZE,
      }),
    );

    const files: ListedFile[] = [];
    for (const obj of pageRes.Contents ?? []) {
      if (!obj.Key || obj.Key === prefix) continue;
      if (obj.Key.startsWith(THUMB_PREFIX) || obj.Key.startsWith(PREVIEW_PREFIX)) continue;
      files.push({
        key: obj.Key,
        size: obj.Size ?? 0,
        lastModified: obj.LastModified?.toISOString() ?? '',
        kind: classifyKey(obj.Key),
        etag: parseEtag(obj.ETag),
        // TODO(S3B-16b): populate via /head fanout or sidecar
        createdAt: undefined,
      });
    }

    ctx.log.info('list', { prefix, recursive: true, fileCount: files.length });
    return {
      prefix,
      folders: [],
      files,
      nextToken: pageRes.IsTruncated ? pageRes.NextContinuationToken : undefined,
    };
  }

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
    if (cp.Prefix && cp.Prefix !== THUMB_PREFIX && cp.Prefix !== PREVIEW_PREFIX) folders.push(cp.Prefix);
  }

  const rawFiles: Array<{ key: string; size: number; lastModified: string; etag?: string }> = [];
  for (const obj of pageRes.Contents ?? []) {
    if (!obj.Key || obj.Key === prefix) continue;
    rawFiles.push({
      key: obj.Key,
      size: obj.Size ?? 0,
      lastModified: obj.LastModified?.toISOString() ?? '',
      etag: parseEtag(obj.ETag),
    });
  }

  // TODO(S3B-16b): populate createdAt via /head fanout or sidecar.

  const files: ListedFile[] = await Promise.all(
    rawFiles.map(async (f) => {
      const kind = classifyKey(f.key);
      let previewUrl: string | undefined;
      if (kind === 'image') {
        const expectedThumb = thumbKey(f.key);
        if (thumbKeys.has(expectedThumb)) {
          previewUrl = await getSignedUrl(
            s3,
            new GetObjectCommand({ Bucket: BUCKET, Key: expectedThumb }),
            { expiresIn: PREVIEW_TTL },
          );
        }
        // If no thumb exists, leave previewUrl undefined — Browse calls
        // /get-derived-url to generate and cache it on demand.
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
      return { ...f, kind, previewUrl, createdAt: undefined };
    }),
  );

  ctx.log.info('list', { prefix, recursive: false, fileCount: files.length, folderCount: folders.length });
  return {
    prefix,
    folders,
    files,
    nextToken: pageRes.IsTruncated ? pageRes.NextContinuationToken : undefined,
  };
}
