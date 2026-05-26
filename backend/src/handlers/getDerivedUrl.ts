import crypto from 'node:crypto';
import { GetObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { ensureDerived, NotAnImageError, UnsupportedFormatError } from '../derive.js';
import { classifyKey } from '../mediaType.js';
import { videoPreviewKey } from '../previews.js';
import { BUCKET, s3, sanitizeKey } from '../s3.js';
import { readJob } from '../jobs.js';
import { createTranscodeJobRecord, writeJob } from '../jobs.js';
import { readActiveTranscodeJobId, writeActiveTranscodeJobId } from '../jobDedupe.js';
import { enqueueTranscodeJob } from '../sqs.js';
import type {
  DerivedTier,
  GetDerivedUrlRequest,
  GetDerivedUrlResponse,
  GetDerivedUrlError,
} from '../types.js';
import type { RequestContext } from '../index.js';

const EXPIRES_IN = 600;

const VALID_TIERS = new Set<DerivedTier>(['thumbnail', 'preview']);

async function headExists(key: string): Promise<boolean> {
  try {
    await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key }));
    return true;
  } catch {
    return false;
  }
}

// Terminal statuses — a job in one of these is not worth reusing.
const TERMINAL_STATUSES = new Set(['completed', 'completed-with-errors', 'cancelled', 'failed']);

export async function getDerivedUrl(
  body: GetDerivedUrlRequest,
  ctx: RequestContext,
): Promise<GetDerivedUrlResponse | GetDerivedUrlError> {
  const key = sanitizeKey(body.key);

  const tier: DerivedTier = body.tier;
  if (!VALID_TIERS.has(tier)) {
    throw new Error(`tier must be 'thumbnail' or 'preview'; got: ${String(tier)}`);
  }

  // Video preview path: async via TranscodeWorker.
  if (classifyKey(key) === 'video' && tier === 'preview') {
    const previewK = videoPreviewKey(key);

    // Cache hit — preview already exists.
    if (await headExists(previewK)) {
      const url = await getSignedUrl(
        s3,
        new GetObjectCommand({ Bucket: BUCKET, Key: previewK }),
        { expiresIn: EXPIRES_IN },
      );
      ctx.log.info('get-derived-url video preview hit', { key, tier });
      return { url, expiresIn: EXPIRES_IN, tier, generated: false };
    }

    // Dedupe: check for an in-flight transcode job for this key.
    const existingJobId = await readActiveTranscodeJobId(key);
    if (existingJobId) {
      const existingRecord = await readJob(existingJobId);
      if (existingRecord && !TERMINAL_STATUSES.has(existingRecord.status)) {
        ctx.log.info('get-derived-url video preview pending (existing job)', { key, jobId: existingJobId });
        return { status: 'pending', jobId: existingJobId, tier: 'preview' };
      }
      // Existing job is terminal (failed/cancelled) — fall through to enqueue fresh.
    }

    // Enqueue a new transcode job.
    const jobId = crypto.randomUUID();
    const record = createTranscodeJobRecord(jobId, key);
    await writeJob(record);
    await writeActiveTranscodeJobId(key, jobId);
    await enqueueTranscodeJob({ jobId, key });

    ctx.log.info('get-derived-url video preview enqueued', { key, jobId });
    return { status: 'pending', jobId, tier: 'preview' };
  }

  // Image (and non-preview video thumbnail) path: synchronous via sharp.
  let result: { derivedKey: string; generated: boolean };
  try {
    result = await ensureDerived(key, tier);
  } catch (err) {
    if (err instanceof UnsupportedFormatError || err instanceof NotAnImageError) {
      ctx.log.warn('get-derived-url unsupported', { key, tier });
      return { url: null, error: 'unsupported_format' };
    }
    throw err;
  }

  const url = await getSignedUrl(
    s3,
    new GetObjectCommand({ Bucket: BUCKET, Key: result.derivedKey }),
    { expiresIn: EXPIRES_IN },
  );

  ctx.log.info('get-derived-url', { key, tier, generated: result.generated });
  return { url, expiresIn: EXPIRES_IN, tier, generated: result.generated };
}
