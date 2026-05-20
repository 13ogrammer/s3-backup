import { GetObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { classifyKey } from '../mediaType.js';
import { readFolderCounts, writeFolderCounts } from '../folderCountsCache.js';
import { BUCKET, s3, sanitizePrefix } from '../s3.js';
import { thumbKey, thumbPrefix } from '../thumbs.js';
import type { FolderCounts, FolderPreviewRequest, FolderPreviewResponse, FolderPreviewThumb } from '../types.js';
import type { RequestContext } from '../index.js';

const PREVIEW_TTL = 60 * 10;
const MAX_THUMBS = 3;
const SCAN_MAX_KEYS = 100;

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

type MediaCandidate = { key: string; lastModified: Date; kind: 'image' | 'video' };

async function scanPrefix(prefix: string): Promise<{
  candidates: MediaCandidate[];
  hasContent: boolean;
  subPrefixes: string[];
}> {
  const res = await s3.send(
    new ListObjectsV2Command({
      Bucket: BUCKET,
      Prefix: prefix,
      Delimiter: '/',
      MaxKeys: SCAN_MAX_KEYS,
    }),
  );

  const hasContent =
    (res.Contents ?? []).length > 0 || (res.CommonPrefixes ?? []).length > 0;

  const subPrefixes = (res.CommonPrefixes ?? [])
    .map((cp) => cp.Prefix)
    .filter((p): p is string => !!p)
    .sort();

  const candidates: MediaCandidate[] = [];
  for (const obj of res.Contents ?? []) {
    if (!obj.Key || obj.Key === prefix) continue;
    const kind = classifyKey(obj.Key);
    if (kind === 'image' || kind === 'video') {
      candidates.push({
        key: obj.Key,
        lastModified: obj.LastModified ?? new Date(0),
        kind,
      });
    }
  }

  // Sort by LastModified desc so we pick the most recent items first.
  candidates.sort((a, b) => b.lastModified.getTime() - a.lastModified.getTime());

  return { candidates, hasContent, subPrefixes };
}

/**
 * Skipped prefixes during the recursive counts walk. These are internal
 * derived-asset trees and cache files that should not count as user content.
 */
const SKIP_PREFIXES = ['.thumbnails/', '.previews/', '.cache/'];

/**
 * The maximum number of S3 keys to scan for a single folder's count. If the
 * walk hits this cap the result is marked truncated=true. One ListObjectsV2
 * page is 1000 keys so the cap is 50 pages of work in the worst case.
 */
const COUNTS_SCAN_MAX = 50_000;

/**
 * Recursively counts all user files under `prefix` with no Delimiter so the
 * full subtree is counted in a single paginated walk. Skips internal
 * derived-asset prefixes (.thumbnails/, .previews/, .cache/). Caps at
 * COUNTS_SCAN_MAX keys and sets truncated=true if the cap is hit.
 *
 * Caching strategy:
 *  - Warm path: result is read from S3 at .cache/folder-counts/<prefix>.json
 *    before the walk begins and returned directly if within the 20-min TTL.
 *  - Cold path: full walk is performed synchronously on the same request,
 *    then written back to cache for future calls.
 *  - Invalidation: del.ts and move.ts call invalidateAncestors() after a
 *    successful operation so stale counts are evicted promptly. TTL is the
 *    final safety net for operations that miss invalidation.
 */
async function computeRecursiveCounts(prefix: string): Promise<FolderCounts> {
  let images = 0;
  let videos = 0;
  let other = 0;
  let scanned = 0;
  let truncated = false;
  let continuationToken: string | undefined;

  outer: do {
    const res = await s3.send(
      new ListObjectsV2Command({
        Bucket: BUCKET,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      }),
    );
    for (const obj of res.Contents ?? []) {
      if (!obj.Key || obj.Key === prefix) continue;
      // Skip internal derived-asset trees so counts reflect only user files.
      if (SKIP_PREFIXES.some((sp) => obj.Key!.startsWith(sp))) continue;
      const kind = classifyKey(obj.Key);
      if (kind === 'image') images++;
      else if (kind === 'video') videos++;
      else other++;
      scanned++;
      if (scanned >= COUNTS_SCAN_MAX) {
        truncated = true;
        break outer;
      }
    }
    continuationToken = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (continuationToken);

  return { total: images + videos + other, images, videos, other, truncated };
}

export async function getCounts(prefix: string): Promise<FolderCounts> {
  const cached = await readFolderCounts(prefix);
  if (cached) return cached;
  const counts = await computeRecursiveCounts(prefix);
  // Best-effort write — a write failure doesn't affect the response.
  writeFolderCounts(prefix, counts).catch(() => undefined);
  return counts;
}

export async function folderPreview(body: FolderPreviewRequest, ctx: RequestContext): Promise<FolderPreviewResponse> {
  if (!body.prefix) throw new Error('prefix is required');
  const prefix = sanitizePrefix(body.prefix);
  if (!prefix) throw new Error('prefix is required');

  // Run the thumb scan and counts cache read in parallel. Using allSettled so
  // a counts failure cannot prevent thumbs from being returned.
  const [scanResult, countsResult] = await Promise.allSettled([
    (async () => {
      const { candidates, hasContent, subPrefixes } = await scanPrefix(prefix);
      let effectiveCandidates = candidates;
      let effectivePrefix = prefix;
      // One-level recursion: if no media at this level but sub-prefixes exist,
      // try the first alphabetical sub-prefix (depth cap: 1).
      if (effectiveCandidates.length === 0 && subPrefixes.length > 0) {
        const subResult = await scanPrefix(subPrefixes[0]!);
        effectiveCandidates = subResult.candidates;
        effectivePrefix = subPrefixes[0]!;
      }
      return { candidates: effectiveCandidates, hasContent, effectivePrefix };
    })(),
    getCounts(prefix),
  ]);

  if (scanResult.status === 'rejected') {
    // Thumb scan failed entirely — propagate as an error.
    throw scanResult.reason as Error;
  }

  const { candidates: effectiveCandidates, hasContent, effectivePrefix } = scanResult.value;
  const counts: FolderCounts | undefined =
    countsResult.status === 'fulfilled' ? countsResult.value : undefined;

  if (effectiveCandidates.length === 0) {
    return { prefix, thumbs: [], hasContent, ...(counts !== undefined ? { counts } : {}) };
  }

  const top = effectiveCandidates.slice(0, MAX_THUMBS);

  // List thumbnail sidecars for the prefix that actually holds the media.
  const thumbKeys = await listThumbKeys(effectivePrefix);

  const thumbs: FolderPreviewThumb[] = await Promise.all(
    top
      .filter((c) => thumbKeys.has(thumbKey(c.key)))
      .map(async (c): Promise<FolderPreviewThumb> => {
        const tk = thumbKey(c.key);
        const url = await getSignedUrl(
          s3,
          new GetObjectCommand({ Bucket: BUCKET, Key: tk }),
          { expiresIn: PREVIEW_TTL },
        );
        return { key: c.key, url, kind: c.kind };
      }),
  );

  ctx.log.info('folder-preview', { prefix, thumbCount: thumbs.length, hasContent });
  return { prefix, thumbs, hasContent, ...(counts !== undefined ? { counts } : {}) };
}
