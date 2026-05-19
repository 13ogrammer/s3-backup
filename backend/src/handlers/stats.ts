import { ListObjectsV2Command } from '@aws-sdk/client-s3';
import { classifyKey } from '../mediaType.js';
import { BUCKET, s3 } from '../s3.js';
import { THUMB_PREFIX } from '../thumbs.js';
import { PREVIEW_PREFIX } from '../previews.js';
import { CACHE_PREFIX, readCache, writeCache } from '../statsCache.js';
import type { StorageStats, StorageStatsRequest } from '../types.js';
import type { RequestContext } from '../index.js';

const MB_500 = 500 * 1024 * 1024;
const GB_1 = 1024 * 1024 * 1024;
const USD_PER_GB = 0.023;
const LARGE_FILES_CAP = 20;
const TOP_FOLDERS_CAP = 5;

// CloudWatch is imported lazily so MinIO dev environments never need it.
async function fetchGrowth(): Promise<Array<{ date: string; bytes: number; count: number }>> {
  try {
    const { CloudWatchClient, GetMetricStatisticsCommand } = await import(
      '@aws-sdk/client-cloudwatch'
    );

    const region = process.env.AWS_REGION ?? 'us-east-1';
    const bucketName = BUCKET;
    const cw = new CloudWatchClient({ region });

    const endTime = new Date();
    const startTime = new Date(endTime.getTime() - 30 * 24 * 60 * 60 * 1000);

    const [bytesRes, countRes] = await Promise.all([
      cw.send(
        new GetMetricStatisticsCommand({
          Namespace: 'AWS/S3',
          MetricName: 'BucketSizeBytes',
          Dimensions: [
            { Name: 'BucketName', Value: bucketName },
            { Name: 'StorageType', Value: 'StandardStorage' },
          ],
          StartTime: startTime,
          EndTime: endTime,
          Period: 86400,
          Statistics: ['Average'],
        }),
      ),
      cw.send(
        new GetMetricStatisticsCommand({
          Namespace: 'AWS/S3',
          MetricName: 'NumberOfObjects',
          Dimensions: [
            { Name: 'BucketName', Value: bucketName },
            { Name: 'StorageType', Value: 'AllStorageTypes' },
          ],
          StartTime: startTime,
          EndTime: endTime,
          Period: 86400,
          Statistics: ['Average'],
        }),
      ),
    ]);

    // Build a map of date → { bytes, count } from CloudWatch datapoints.
    const byDate = new Map<string, { bytes: number; count: number }>();

    for (const dp of bytesRes.Datapoints ?? []) {
      if (!dp.Timestamp) continue;
      const date = dp.Timestamp.toISOString().slice(0, 10);
      const entry = byDate.get(date) ?? { bytes: 0, count: 0 };
      entry.bytes = Math.round(dp.Average ?? 0);
      byDate.set(date, entry);
    }

    for (const dp of countRes.Datapoints ?? []) {
      if (!dp.Timestamp) continue;
      const date = dp.Timestamp.toISOString().slice(0, 10);
      const entry = byDate.get(date) ?? { bytes: 0, count: 0 };
      entry.count = Math.round(dp.Average ?? 0);
      byDate.set(date, entry);
    }

    return Array.from(byDate.entries())
      .map(([date, v]) => ({ date, bytes: v.bytes, count: v.count }))
      .sort((a, b) => a.date.localeCompare(b.date));
  } catch {
    // MinIO / new bucket / no CloudWatch access — return empty gracefully.
    return [];
  }
}

// Min-heap of fixed capacity used to track top N items without sorting the full list.
function insertCapped<T>(
  heap: T[],
  cap: number,
  item: T,
  scoreOf: (x: T) => number,
): T[] {
  if (heap.length < cap) {
    heap.push(item);
    return heap;
  }
  const minScore = Math.min(...heap.map(scoreOf));
  if (scoreOf(item) > minScore) {
    // Replace the smallest element.
    const minIdx = heap.findIndex((x) => scoreOf(x) === minScore);
    heap[minIdx] = item;
  }
  return heap;
}

export async function stats(
  body: StorageStatsRequest,
  ctx: RequestContext,
): Promise<StorageStats> {
  const refresh = body.refresh === true;

  if (!refresh) {
    const cached = await readCache();
    if (cached) {
      ctx.log.info('stats cache hit', { generatedAt: cached.generatedAt });
      return { ...cached, cached: true };
    }
  }

  // Walk the entire bucket, skipping derived-asset prefixes.
  let totalBytes = 0;
  let totalCount = 0;
  const byType = {
    photos: { bytes: 0, count: 0 },
    videos: { bytes: 0, count: 0 },
    other:  { bytes: 0, count: 0 },
  };
  const largeFilesHeap: Array<{ key: string; sizeBytes: number; lastModified: string }> = [];
  const veryLargeFilesHeap: Array<{ key: string; sizeBytes: number; lastModified: string }> = [];
  const folderBytes = new Map<string, number>();
  const folderCount = new Map<string, number>();

  let continuationToken: string | undefined;
  do {
    const res = await s3.send(
      new ListObjectsV2Command({
        Bucket: BUCKET,
        ContinuationToken: continuationToken,
        MaxKeys: 1000,
      }),
    );

    for (const obj of res.Contents ?? []) {
      const key = obj.Key;
      if (!key) continue;

      // Skip derived-asset trees and the stats cache itself.
      if (
        key.startsWith(THUMB_PREFIX) ||
        key.startsWith(PREVIEW_PREFIX) ||
        key.startsWith(CACHE_PREFIX)
      ) continue;

      const size = obj.Size ?? 0;
      const lastModified = obj.LastModified?.toISOString() ?? '';

      totalBytes += size;
      totalCount += 1;

      const kind = classifyKey(key);
      if (kind === 'image') {
        byType.photos.bytes += size;
        byType.photos.count += 1;
      } else if (kind === 'video') {
        byType.videos.bytes += size;
        byType.videos.count += 1;
      } else {
        byType.other.bytes += size;
        byType.other.count += 1;
      }

      // Top-level folder: everything before the first '/'.
      const slashIdx = key.indexOf('/');
      if (slashIdx > 0) {
        const topFolder = key.slice(0, slashIdx + 1);
        folderBytes.set(topFolder, (folderBytes.get(topFolder) ?? 0) + size);
        folderCount.set(topFolder, (folderCount.get(topFolder) ?? 0) + 1);
      }

      if (size >= MB_500) {
        const entry = { key, sizeBytes: size, lastModified };
        insertCapped(largeFilesHeap, LARGE_FILES_CAP, entry, (x) => x.sizeBytes);
      }
      if (size >= GB_1) {
        const entry = { key, sizeBytes: size, lastModified };
        insertCapped(veryLargeFilesHeap, LARGE_FILES_CAP, entry, (x) => x.sizeBytes);
      }
    }

    continuationToken = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (continuationToken);

  const largeFiles = largeFilesHeap.sort((a, b) => b.sizeBytes - a.sizeBytes);
  const veryLargeFiles = veryLargeFilesHeap.sort((a, b) => b.sizeBytes - a.sizeBytes);

  const topFolders = Array.from(folderBytes.entries())
    .map(([prefix, bytes]) => ({ prefix, bytes, count: folderCount.get(prefix) ?? 0 }))
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, TOP_FOLDERS_CAP);

  const estimatedMonthlyUsd = Math.round((totalBytes / 1e9) * USD_PER_GB * 100) / 100;

  const growth = await fetchGrowth();

  const result: StorageStats = {
    totalBytes,
    totalCount,
    estimatedMonthlyUsd,
    byType,
    largeFiles,
    veryLargeFiles,
    topFolders,
    growth,
    generatedAt: new Date().toISOString(),
    cached: false,
  };

  // Best-effort write — don't let a cache write failure surface to the caller.
  writeCache(result).catch(() => undefined);

  ctx.log.info('stats generated', {
    totalBytes,
    totalCount,
    largeFiles: largeFiles.length,
    veryLargeFiles: veryLargeFiles.length,
  });

  return result;
}
