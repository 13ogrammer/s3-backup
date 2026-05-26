// SQS handler for async video preview transcoding.
//
// Flow per message:
//   1. HEAD short-circuit: if videoPreviewKey already exists, mark completed and return.
//   2. Stream original from S3 to /tmp/<jobId>/in.<ext>.
//   3. Spawn ffmpeg to produce /tmp/<jobId>/out.mp4.
//   4. PUT output to videoPreviewKey in S3 (Content-Type: video/mp4).
//   5. setTerminalStatus completed + clearActiveTranscodeJobId.
//   6. /tmp cleanup in finally (best-effort).
//
// On any error: setTerminalStatus failed + clearActiveTranscodeJobId.
// The SQS message is then deleted by the event-source integration so the
// job does not retry; clients see the failed status and can request re-generation
// by calling /get-derived-url again (which will enqueue a fresh job).

import { createWriteStream, existsSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';
import type { SQSEvent } from 'aws-lambda';
import { GetObjectCommand, HeadObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { createReadStream } from 'node:fs';
import { createLogger } from '../logger.js';
import { readJob, writeJob, setTerminalStatus, createTranscodeJobRecord } from '../jobs.js';
import { BUCKET, s3 } from '../s3.js';
import { videoPreviewKey } from '../previews.js';
import { transcodeVideoToPreview } from '../ffmpeg.js';
import { clearActiveTranscodeJobId } from '../jobDedupe.js';
import type { TranscodeJobMessage } from '../types.js';

async function headExists(key: string): Promise<boolean> {
  try {
    await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key }));
    return true;
  } catch {
    return false;
  }
}

function extOf(key: string): string {
  const dot = key.lastIndexOf('.');
  const slash = key.lastIndexOf('/');
  return dot > slash ? key.slice(dot + 1).toLowerCase() : 'mp4';
}

export async function processTranscodeJob(msg: TranscodeJobMessage): Promise<void> {
  const log = createLogger({ requestId: msg.jobId, route: 'transcode-worker' });
  log.info('transcode-worker start', { jobId: msg.jobId, key: msg.key });

  const previewKey = videoPreviewKey(msg.key);
  const tmpDir = `/tmp/${msg.jobId}`;

  // Ensure we have a job record to update. The API handler writes it before enqueuing,
  // but guard in case of an unexpected race.
  let record = await readJob(msg.jobId);
  if (!record) {
    log.warn('job record not found, creating synthetic record', { jobId: msg.jobId });
    record = createTranscodeJobRecord(msg.jobId, msg.key);
    await writeJob(record);
  }
  if (record.kind !== 'video-transcode') {
    log.warn('unexpected job kind in TranscodeWorker, skipping', { jobId: msg.jobId, kind: record.kind });
    return;
  }

  // HEAD short-circuit: preview already exists (e.g. duplicate message).
  if (await headExists(previewKey)) {
    log.info('preview already exists, marking completed', { jobId: msg.jobId, previewKey });
    await setTerminalStatus(record, 'completed');
    await clearActiveTranscodeJobId(msg.key).catch(() => {});
    return;
  }

  // Mark running.
  record.status = 'running';
  record.updatedAt = new Date().toISOString();
  await writeJob(record);

  const inputPath = `${tmpDir}/in.${extOf(msg.key)}`;
  const outputPath = `${tmpDir}/out.mp4`;

  try {
    await mkdir(tmpDir, { recursive: true });

    // Stream original from S3 to disk.
    log.info('downloading original', { key: msg.key });
    const obj = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: msg.key }));
    if (!obj.Body) throw new Error('S3 object has no body');
    await pipeline(obj.Body as Readable, createWriteStream(inputPath));

    // Transcode.
    log.info('transcoding', { inputPath, outputPath });
    await transcodeVideoToPreview(inputPath, outputPath, (m) => log.info(m));

    // Upload preview.
    log.info('uploading preview', { previewKey });
    if (!existsSync(outputPath)) throw new Error('ffmpeg produced no output file');
    await s3.send(
      new PutObjectCommand({
        Bucket: BUCKET,
        Key: previewKey,
        Body: createReadStream(outputPath),
        ContentType: 'video/mp4',
      }),
    );

    await setTerminalStatus(record, 'completed');
    await clearActiveTranscodeJobId(msg.key).catch(() => {});
    log.info('transcode-worker complete', { jobId: msg.jobId, previewKey });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('transcode-worker failed', { jobId: msg.jobId, error: message });
    await setTerminalStatus(record, 'failed', message).catch(() => {});
    await clearActiveTranscodeJobId(msg.key).catch(() => {});
    throw err; // Re-throw so SQS does not delete the message (handled by caller in dev-poller).
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

export const handler = async (event: SQSEvent): Promise<void> => {
  for (const record of event.Records) {
    const msg = JSON.parse(record.body) as TranscodeJobMessage;
    try {
      await processTranscodeJob(msg);
    } catch {
      // Swallow so remaining SQS records in the batch are processed.
      // Lambda SQS integration with batchSize=1 means there's only ever 1 record,
      // but guard for forward compatibility.
    }
  }
};
