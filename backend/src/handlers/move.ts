import {
  HeadObjectCommand,
  ListObjectsV2Command,
} from '@aws-sdk/client-s3';
import { Accepted202, ConflictError, TooLargeError } from '../errors.js';
import { invalidateAncestors } from '../folderCountsCache.js';
import { createJobRecord, writeJob } from '../jobs.js';
import { getCounts } from './folderPreview.js';
import { enqueueMoveJob } from '../sqs.js';
import { BUCKET, s3, sanitizeKey, sanitizePrefix } from '../s3.js';
import { moveOneObject, existsInBucket } from './__shared/moveOps.js';
import type { MoveRequest, MoveResponse } from '../types.js';
import type { RequestContext } from '../index.js';

const MAX_FILES_PER_JOB = Number(process.env.MAX_FILES_PER_JOB ?? 10_000);

async function assertFolderDestinationFree(toPrefix: string): Promise<void> {
  const res = await s3.send(
    new ListObjectsV2Command({ Bucket: BUCKET, Prefix: toPrefix, MaxKeys: 1 }),
  );
  if (res.Contents && res.Contents.length > 0) {
    throw new ConflictError(
      `Destination folder ${toPrefix} already exists. Rename one of the folders or move into a different parent.`,
    );
  }
}

async function assertFileDestinationFree(toKey: string): Promise<void> {
  if (await existsInBucket(toKey)) {
    throw new ConflictError(`Destination ${toKey} already exists.`);
  }
}

export async function move(body: MoveRequest, ctx: RequestContext): Promise<MoveResponse> {
  if (body.kind === 'file') {
    const from = sanitizeKey(body.from);
    const to = sanitizeKey(body.to);
    if (from === to) return { moved: 0 };
    await assertFileDestinationFree(to);

    try {
      await moveOneObject(from, to);
      ctx.log.info('move', { kind: 'file', from, to });
      // Best-effort invalidation of folder-count cache for source and
      // destination parent directories and their ancestors.
      try {
        const fromDir = from.includes('/') ? from.slice(0, from.lastIndexOf('/') + 1) : '';
        const toDir   = to.includes('/')   ? to.slice(0, to.lastIndexOf('/') + 1)   : '';
        const dirs = new Set([fromDir, toDir].filter(Boolean));
        await Promise.allSettled(Array.from(dirs).map((d) => invalidateAncestors(d)));
      } catch { /* best-effort */ }
      return { moved: 1 };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      ctx.log.warn('move file failed', { from, to, reason });
      return { moved: 0, failed: [{ key: from, reason }] };
    }
  }

  if (body.kind === 'folder-keys') {
    // Retry-failed path: producer was given a specific key list by the client.
    const fromPrefix = sanitizePrefix(body.fromPrefix);
    const toPrefix = sanitizePrefix(body.toPrefix);
    if (fromPrefix === '' || toPrefix === '') throw new Error('prefixes must be non-empty for folder move');
    if (fromPrefix === toPrefix) throw new ConflictError('source and destination are the same');
    if (toPrefix.startsWith(fromPrefix)) throw new Error('cannot move a folder into itself');

    const keys = body.keys;
    if (!Array.isArray(keys) || keys.length === 0) throw new Error('keys must be a non-empty array');

    const jobId = crypto.randomUUID();
    const retryOf = typeof body.retryOfJobId === 'string' ? body.retryOfJobId : undefined;
    const record = createJobRecord(jobId, fromPrefix, toPrefix, keys.length, retryOf);
    await writeJob(record);

    await enqueueMoveJob({ jobId, fromPrefix, toPrefix, keys });
    ctx.log.info('move job queued (folder-keys)', { jobId, fromPrefix, toPrefix, total: keys.length, retryOf });

    throw new Accepted202({ jobId, status: 'queued' });
  }

  // kind === 'folder': async job path
  const fromPrefix = sanitizePrefix(body.fromPrefix);
  const toPrefix = sanitizePrefix(body.toPrefix);
  if (fromPrefix === '' || toPrefix === '') {
    throw new Error('prefixes must be non-empty for folder move');
  }
  if (fromPrefix === toPrefix) return { moved: 0 };
  if (toPrefix.startsWith(fromPrefix)) {
    throw new Error('cannot move a folder into itself');
  }
  await assertFolderDestinationFree(toPrefix);

  // Gate on file count before accepting the job.
  const counts = await getCounts(fromPrefix);
  if (counts.truncated || counts.total > MAX_FILES_PER_JOB) {
    throw new TooLargeError(counts.total, MAX_FILES_PER_JOB, counts.truncated);
  }

  const jobId = crypto.randomUUID();
  const record = createJobRecord(jobId, fromPrefix, toPrefix, counts.total);
  await writeJob(record);

  await enqueueMoveJob({ jobId, fromPrefix, toPrefix });
  ctx.log.info('move job queued', { jobId, fromPrefix, toPrefix, total: counts.total });

  throw new Accepted202({ jobId, status: 'queued' });
}
