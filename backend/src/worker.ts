import type { SQSEvent } from 'aws-lambda';
import { ListObjectsV2Command } from '@aws-sdk/client-s3';
import { createLogger } from './logger.js';
import { readJob, writeJob, setTerminalStatus, updateProgress } from './jobs.js';
import { BUCKET, s3, sanitizePrefix } from './s3.js';
import { invalidateAncestors } from './folderCountsCache.js';
import { moveOneObject, existsInBucket } from './handlers/__shared/moveOps.js';
import { mapWithConcurrency } from './concurrency.js';
import type { MoveJobMessage, MoveFailure } from './types.js';

const PROGRESS_FLUSH_INTERVAL = 100;
const WORKER_PARALLELISM = Number(process.env.WORKER_PARALLELISM ?? 16);

export async function processJob(msg: MoveJobMessage): Promise<void> {
  const log = createLogger({ requestId: msg.jobId, route: 'worker' });
  log.info('worker start', { jobId: msg.jobId, fromPrefix: msg.fromPrefix });

  const record = await readJob(msg.jobId);
  if (!record) {
    log.warn('job record not found', { jobId: msg.jobId });
    return;
  }

  if (record.status === 'cancelled') {
    log.info('job already cancelled, skipping', { jobId: msg.jobId });
    return;
  }

  // Mark running
  record.status = 'running';
  record.updatedAt = new Date().toISOString();
  await writeJob(record);

  const fromPrefix = sanitizePrefix(record.fromPrefix);
  const toPrefix = sanitizePrefix(record.toPrefix);

  // Collect keys to process — either from the message (explicit key list for
  // folder-keys / retry-failed) or by walking the source prefix.
  let keys: string[];
  if (msg.keys && msg.keys.length > 0) {
    // folder-keys mode: caller picked specific keys. Per-item moveOneObject
    // handles destination collisions into JobRecord.failed[]; do NOT reject
    // the whole job because the destination prefix has other content.
    keys = msg.keys;
  } else {
    // Full-folder mode: refuse if destination has any existing content, since
    // the source is moved wholesale and silent overwrites would be data loss.
    const destCheck = await s3.send(
      new ListObjectsV2Command({ Bucket: BUCKET, Prefix: toPrefix, MaxKeys: 1 }),
    );
    if (destCheck.Contents && destCheck.Contents.length > 0) {
      await setTerminalStatus(record, 'failed', 'destination occupied');
      log.warn('destination occupied, aborting', { jobId: msg.jobId, toPrefix });
      return;
    }

    keys = [];
    let continuationToken: string | undefined;
    do {
      const res = await s3.send(
        new ListObjectsV2Command({
          Bucket: BUCKET,
          Prefix: fromPrefix,
          ContinuationToken: continuationToken,
        }),
      );
      for (const obj of res.Contents ?? []) {
        if (obj.Key) keys.push(obj.Key);
      }
      continuationToken = res.IsTruncated ? res.NextContinuationToken : undefined;
    } while (continuationToken);
  }

  // Update total if the walk found a different count from what was estimated.
  if (record.total !== keys.length) {
    record.total = keys.length;
    await writeJob(record);
  }

  let moved = 0;
  const failed: MoveFailure[] = [];
  let pendingFlush = 0;

  // Process keys with bounded concurrency. We break the list into batches of
  // PROGRESS_FLUSH_INTERVAL so cancel checks and progress writes happen
  // regularly even when concurrency would let the whole list race to completion.
  for (let batchStart = 0; batchStart < keys.length; batchStart += PROGRESS_FLUSH_INTERVAL) {
    // Refresh the record to check for cancel.
    const fresh = await readJob(msg.jobId);
    if (fresh?.cancelRequested) {
      await setTerminalStatus(record, 'cancelled');
      log.info('job cancelled by request', { jobId: msg.jobId, moved, failed: failed.length });
      return;
    }

    const batch = keys.slice(batchStart, batchStart + PROGRESS_FLUSH_INTERVAL);

    await mapWithConcurrency(batch, WORKER_PARALLELISM, async (key) => {
      const newKey = toPrefix + key.slice(fromPrefix.length);
      try {
        await moveOneObject(key, newKey);
        moved += 1;
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        log.warn('item move failed', { key, reason });
        failed.push({ key, reason });
      }
    });

    pendingFlush += batch.length;
    if (pendingFlush >= PROGRESS_FLUSH_INTERVAL) {
      record.moved = moved;
      record.failed = failed;
      await updateProgress(record, moved, [...failed]);
      pendingFlush = 0;
    }
  }

  // Final terminal write.
  record.moved = moved;
  record.failed = failed;
  const terminalStatus = failed.length > 0 ? 'completed-with-errors' : 'completed';
  await setTerminalStatus(record, terminalStatus);

  // Best-effort cache invalidation for both sides.
  try {
    await Promise.allSettled([
      invalidateAncestors(fromPrefix),
      invalidateAncestors(toPrefix),
    ]);
  } catch { /* best-effort */ }

  log.info('worker complete', { jobId: msg.jobId, moved, failed: failed.length, status: terminalStatus });
}

export const handler = async (event: SQSEvent): Promise<void> => {
  for (const record of event.Records) {
    const msg = JSON.parse(record.body) as MoveJobMessage;
    await processJob(msg);
  }
};
