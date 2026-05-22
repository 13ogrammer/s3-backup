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
import { CACHE_PREFIX } from '../statsCache.js';
import { THUMB_PREFIX, thumbKey, thumbPrefix } from '../thumbs.js';
import type { ListRequest, ListResponse, ListedFile } from '../types.js';
import type { RequestContext } from '../index.js';

const PREVIEW_TTL = 60 * 10;
const PAGE_SIZE = 500;
// Discovery pass uses S3's max page size so a 2–5k file folder finishes in
// 2–5 sequential ListObjectsV2 calls instead of 4–10.
const DISCOVERY_PAGE_SIZE = 1000;
// Cap on how many S3 pages we'll scan looking for CommonPrefixes on the
// first /list call. 50 pages × 1000 = 50k keys — covers virtually every
// real folder. Beyond this, foldersTruncated=true and the client falls
// back to discovering remaining folders as it paginates files.
const MAX_FOLDER_DISCOVERY_PAGES = 50;

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

type RawFile = { key: string; size: number; lastModified: string; etag?: string };

function isReservedFolder(p: string): boolean {
  return p === THUMB_PREFIX || p === PREVIEW_PREFIX || p === CACHE_PREFIX;
}

async function enrichFiles(rawFiles: RawFile[], thumbKeys: Set<string>): Promise<ListedFile[]> {
  return Promise.all(
    rawFiles.map(async (f) => {
      const kind = classifyKey(f.key);
      let previewUrl: string | undefined;
      if (kind === 'image' || kind === 'video') {
        // Videos have a thumb sidecar but no useful fallback (the original
        // is video bytes, not a still). If no thumb exists, leave previewUrl
        // undefined and let the client render a placeholder tile.
        const expectedThumb = thumbKey(f.key);
        if (thumbKeys.has(expectedThumb)) {
          previewUrl = await getSignedUrl(
            s3,
            new GetObjectCommand({ Bucket: BUCKET, Key: expectedThumb }),
            { expiresIn: PREVIEW_TTL },
          );
        }
      }
      // TODO(S3B-16b): populate createdAt via /head fanout or sidecar.
      return { ...f, kind, previewUrl, createdAt: undefined };
    }),
  );
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
      if (
        obj.Key.startsWith(THUMB_PREFIX) ||
        obj.Key.startsWith(PREVIEW_PREFIX) ||
        obj.Key.startsWith(CACHE_PREFIX)
      ) continue;
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

  // Subsequent-page call: client already has folders from the first call,
  // so we only return more files here.
  if (body.continuationToken) {
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
    const rawFiles: RawFile[] = [];
    for (const obj of pageRes.Contents ?? []) {
      if (!obj.Key || obj.Key === prefix) continue;
      rawFiles.push({
        key: obj.Key,
        size: obj.Size ?? 0,
        lastModified: obj.LastModified?.toISOString() ?? '',
        etag: parseEtag(obj.ETag),
      });
    }
    const files = await enrichFiles(rawFiles, thumbKeys);
    ctx.log.info('list', { prefix, recursive: false, fileCount: files.length, paged: true });
    return {
      prefix,
      folders: [],
      files,
      nextToken: pageRes.IsTruncated ? pageRes.NextContinuationToken : undefined,
    };
  }

  // First page: eager folder discovery. S3's ListObjectsV2 with a delimiter
  // returns Contents and CommonPrefixes interleaved by key order, so a folder
  // whose name sorts after a large block of file keys would not surface until
  // the client paginated past those files. We exhaust pagination here (capped)
  // to return the full folder set on the first response.
  const folders: string[] = [];
  const seenFolders = new Set<string>();
  let firstPageRawFiles: RawFile[] = [];
  let firstPageNextToken: string | undefined;
  let foldersTruncated = false;
  let pages = 0;
  let continuationToken: string | undefined;

  const thumbKeysPromise = listThumbKeys(prefix);

  while (true) {
    const res = await s3.send(
      new ListObjectsV2Command({
        Bucket: BUCKET,
        Prefix: prefix,
        Delimiter: '/',
        ContinuationToken: continuationToken,
        MaxKeys: DISCOVERY_PAGE_SIZE,
      }),
    );
    pages++;

    for (const cp of res.CommonPrefixes ?? []) {
      if (cp.Prefix && !seenFolders.has(cp.Prefix) && !isReservedFolder(cp.Prefix)) {
        seenFolders.add(cp.Prefix);
        folders.push(cp.Prefix);
      }
    }

    if (pages === 1) {
      // Page 1's Contents are the initial file slice. nextToken from this
      // page lets the client continue file pagination from where page 1 ended.
      for (const obj of res.Contents ?? []) {
        if (!obj.Key || obj.Key === prefix) continue;
        firstPageRawFiles.push({
          key: obj.Key,
          size: obj.Size ?? 0,
          lastModified: obj.LastModified?.toISOString() ?? '',
          etag: parseEtag(obj.ETag),
        });
      }
      firstPageNextToken = res.IsTruncated ? res.NextContinuationToken : undefined;
    }

    if (!res.IsTruncated) break;
    if (pages >= MAX_FOLDER_DISCOVERY_PAGES) {
      foldersTruncated = true;
      break;
    }
    continuationToken = res.NextContinuationToken;
  }

  const thumbKeys = await thumbKeysPromise;
  const files = await enrichFiles(firstPageRawFiles, thumbKeys);

  ctx.log.info('list', {
    prefix,
    recursive: false,
    fileCount: files.length,
    folderCount: folders.length,
    discoveryPages: pages,
    foldersTruncated,
  });
  return {
    prefix,
    folders,
    files,
    nextToken: firstPageNextToken,
    foldersTruncated: foldersTruncated || undefined,
  };
}
