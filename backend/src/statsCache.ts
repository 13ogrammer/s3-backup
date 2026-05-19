import {
  GetObjectCommand,
  PutObjectCommand,
  NoSuchKey,
} from '@aws-sdk/client-s3';
import { BUCKET, s3 } from './s3.js';
import type { StorageStats } from './types.js';

export const CACHE_PREFIX = '.cache/';
export const STATS_CACHE_KEY = `${CACHE_PREFIX}stats.json`;
export const STATS_TTL_MS = 60 * 60 * 1000; // 1 hour

export async function readCache(): Promise<StorageStats | null> {
  try {
    const res = await s3.send(
      new GetObjectCommand({ Bucket: BUCKET, Key: STATS_CACHE_KEY }),
    );
    const raw = await res.Body?.transformToString('utf-8');
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StorageStats;
    const age = Date.now() - new Date(parsed.generatedAt).getTime();
    if (age > STATS_TTL_MS) return null;
    return parsed;
  } catch (err) {
    if (err instanceof NoSuchKey) return null;
    // Treat any other read error as a cache miss — stats generation will proceed.
    return null;
  }
}

export async function writeCache(stats: StorageStats): Promise<void> {
  await s3.send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: STATS_CACHE_KEY,
      Body: JSON.stringify(stats),
      ContentType: 'application/json',
    }),
  );
}
