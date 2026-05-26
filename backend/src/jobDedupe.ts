// Dedupe pointer for in-flight TranscodeWorker jobs.
//
// When /get-derived-url triggers a video transcode job it writes a lightweight
// pointer at .cache/jobs/by-key/<sha256(key)>.json containing { jobId }.
// Before enqueueing, the handler reads this pointer and re-uses the jobId
// if it still refers to a live (non-terminal) job. The TranscodeWorker clears
// the pointer when it marks terminal status, and also on the HEAD short-circuit
// path (preview already exists → completed immediately).
//
// sha256 is used rather than the raw key to avoid path-traversal concerns and
// to keep the filename safe regardless of special chars in the S3 key.

import { createHash } from 'node:crypto';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import { BUCKET, s3 } from './s3.js';

function dedupeKey(originalKey: string): string {
  const sha = createHash('sha256').update(originalKey).digest('hex');
  return `.cache/jobs/by-key/${sha}.json`;
}

export async function readActiveTranscodeJobId(originalKey: string): Promise<string | null> {
  try {
    const res = await s3.send(
      new GetObjectCommand({ Bucket: BUCKET, Key: dedupeKey(originalKey) }),
    );
    const body = await res.Body?.transformToString('utf-8');
    if (!body) return null;
    const parsed = JSON.parse(body) as { jobId?: string };
    return parsed.jobId ?? null;
  } catch (err: unknown) {
    const code = (err as { Code?: string; name?: string }).Code ?? (err as { name?: string }).name;
    if (code === 'NoSuchKey' || code === 'NotFound') return null;
    throw err;
  }
}

export async function writeActiveTranscodeJobId(originalKey: string, jobId: string): Promise<void> {
  await s3.send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: dedupeKey(originalKey),
      Body: JSON.stringify({ jobId }),
      ContentType: 'application/json',
    }),
  );
}

export async function clearActiveTranscodeJobId(originalKey: string): Promise<void> {
  await s3.send(
    new DeleteObjectCommand({ Bucket: BUCKET, Key: dedupeKey(originalKey) }),
  );
}
