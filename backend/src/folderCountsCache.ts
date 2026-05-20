/**
 * Prefix-scoped S3 cache for recursive folder file counts.
 *
 * Cache layout: `.cache/folder-counts/<sanitized-prefix>.json`
 * where <sanitized-prefix> is the folder prefix with the trailing slash
 * stripped and interior slashes kept intact (e.g. "photos/2025" → file
 * named "photos/2025.json" under the .cache/folder-counts/ key prefix).
 *
 * TTL: 20 minutes (FOLDER_COUNTS_TTL_MS). Timestamp is embedded in the
 * stored JSON as `_cachedAt` so the cache can be checked on read without
 * a separate HeadObject call.
 *
 * Invalidation: best-effort, called by del.ts and move.ts after a
 * successful operation. Walks up the prefix chain (a/b/c/ → a/b/, a/)
 * and deletes each cache entry. Root ('') is not cached, so the walk
 * stops at single-segment prefixes.
 */

import {
  DeleteObjectCommand,
  GetObjectCommand,
  NoSuchKey,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import { BUCKET, s3 } from './s3.js';
import type { FolderCounts } from './types.js';

export const FOLDER_COUNTS_CACHE_PREFIX = '.cache/folder-counts/';
export const FOLDER_COUNTS_TTL_MS = 20 * 60 * 1000; // 20 minutes

type CachedEntry = FolderCounts & { _cachedAt: string };

export function folderCountsCacheKey(prefix: string): string {
  // Strip trailing slash so "photos/2025/" becomes "photos/2025.json".
  const stripped = prefix.endsWith('/') ? prefix.slice(0, -1) : prefix;
  return `${FOLDER_COUNTS_CACHE_PREFIX}${stripped}.json`;
}

export async function readFolderCounts(prefix: string): Promise<FolderCounts | null> {
  try {
    const res = await s3.send(
      new GetObjectCommand({ Bucket: BUCKET, Key: folderCountsCacheKey(prefix) }),
    );
    const raw = await res.Body?.transformToString('utf-8');
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CachedEntry;
    const age = Date.now() - new Date(parsed._cachedAt).getTime();
    if (age > FOLDER_COUNTS_TTL_MS) return null;
    const { _cachedAt: _unused, ...counts } = parsed;
    void _unused;
    return counts as FolderCounts;
  } catch (err) {
    if (err instanceof NoSuchKey) return null;
    // Any unexpected read error is treated as a cache miss; the handler will
    // compute counts fresh and attempt to write a new entry.
    return null;
  }
}

export async function writeFolderCounts(prefix: string, counts: FolderCounts): Promise<void> {
  const entry: CachedEntry = { ...counts, _cachedAt: new Date().toISOString() };
  await s3.send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: folderCountsCacheKey(prefix),
      Body: JSON.stringify(entry),
      ContentType: 'application/json',
    }),
  );
}

export async function invalidateFolderCounts(prefix: string): Promise<void> {
  if (!prefix) return;
  await s3.send(
    new DeleteObjectCommand({ Bucket: BUCKET, Key: folderCountsCacheKey(prefix) }),
  );
}

export async function invalidateAncestors(prefix: string): Promise<void> {
  // Walk up the chain: "a/b/c/" → invalidate "a/b/c/", "a/b/", "a/".
  // Root ('') has no cache entry so we stop when we've consumed all segments.
  let current = prefix.endsWith('/') ? prefix : prefix + '/';
  while (current.length > 0) {
    try {
      await invalidateFolderCounts(current);
    } catch {
      // Best-effort: swallow errors per individual segment.
    }
    // Strip the last path segment (and its slash) to walk up one level.
    // e.g. "a/b/c/" → strip trailing slash → "a/b/c" → find last "/" → "a/b/"
    const withoutTrailing = current.slice(0, -1);
    const lastSlash = withoutTrailing.lastIndexOf('/');
    if (lastSlash === -1) break; // Was a single top-level segment; done.
    current = withoutTrailing.slice(0, lastSlash + 1);
  }
}
