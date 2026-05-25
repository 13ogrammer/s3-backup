import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { BUCKET, s3 } from './s3.js';
import type { JobRecord, JobStatus, MergePolicy, MoveFailure } from './types.js';

function jobKey(jobId: string): string {
  return `.cache/jobs/${jobId}.json`;
}

export async function readJob(jobId: string): Promise<JobRecord | null> {
  try {
    const res = await s3.send(
      new GetObjectCommand({ Bucket: BUCKET, Key: jobKey(jobId) }),
    );
    const body = await res.Body?.transformToString('utf-8');
    if (!body) return null;
    return JSON.parse(body) as JobRecord;
  } catch (err: unknown) {
    const code = (err as { Code?: string; name?: string }).Code ?? (err as { name?: string }).name;
    if (code === 'NoSuchKey' || code === 'NotFound') return null;
    throw err;
  }
}

export async function writeJob(record: JobRecord): Promise<void> {
  await s3.send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: jobKey(record.jobId),
      Body: JSON.stringify(record),
      ContentType: 'application/json',
    }),
  );
}

export function createJobRecord(
  jobId: string,
  fromPrefix: string,
  toPrefix: string,
  total: number,
  options?: { retryOf?: string; kind?: JobRecord['kind']; policy?: MergePolicy },
): JobRecord {
  const now = new Date().toISOString();
  const kind = options?.kind ?? 'folder-move';
  return {
    jobId,
    kind,
    fromPrefix,
    toPrefix,
    status: 'queued',
    total,
    moved: 0,
    failed: [],
    startedAt: now,
    updatedAt: now,
    ...(options?.retryOf ? { retryOf: options.retryOf } : {}),
    ...(options?.policy ? { policy: options.policy } : {}),
    ...(kind === 'merge' ? { renamed: 0, skipped: 0 } : {}),
  };
}

export async function updateProgress(
  record: JobRecord,
  moved: number,
  failed: MoveFailure[],
): Promise<void> {
  record.moved = moved;
  record.failed = failed;
  record.updatedAt = new Date().toISOString();
  await writeJob(record);
}

export async function setCancelRequested(jobId: string): Promise<JobRecord | null> {
  const record = await readJob(jobId);
  if (!record) return null;
  record.cancelRequested = true;
  record.updatedAt = new Date().toISOString();
  await writeJob(record);
  return record;
}

export async function setTerminalStatus(
  record: JobRecord,
  status: Extract<JobStatus, 'completed' | 'completed-with-errors' | 'cancelled' | 'failed'>,
  error?: string,
): Promise<void> {
  record.status = status;
  record.updatedAt = new Date().toISOString();
  record.completedAt = record.updatedAt;
  if (error) record.error = error;
  await writeJob(record);
}
