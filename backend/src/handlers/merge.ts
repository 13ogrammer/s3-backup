import { Accepted202, TooLargeError } from '../errors.js';
import { createJobRecord, writeJob } from '../jobs.js';
import { getCounts } from './folderPreview.js';
import { enqueueMoveJob } from '../sqs.js';
import { sanitizePrefix } from '../s3.js';
import type { MergeFolderRequest, MergePolicy } from '../types.js';
import type { RequestContext } from '../index.js';

const MAX_FILES_PER_JOB = Number(process.env.MAX_FILES_PER_JOB ?? 10_000);
const VALID_POLICIES = new Set<MergePolicy>(['replace', 'keepBoth', 'skip']);

export async function mergeFolder(body: MergeFolderRequest, ctx: RequestContext): Promise<never> {
  const fromPrefix = sanitizePrefix(body.fromPrefix);
  const toPrefix = sanitizePrefix(body.toPrefix);

  if (!fromPrefix) throw new Error('fromPrefix must be non-empty');
  if (!toPrefix) throw new Error('toPrefix must be non-empty');
  if (fromPrefix === toPrefix) throw new Error('fromPrefix and toPrefix must be different');
  if (toPrefix.startsWith(fromPrefix)) throw new Error('cannot merge a folder into itself');

  const policy = body.policy;
  if (!VALID_POLICIES.has(policy)) {
    throw new Error(`policy must be one of: replace, keepBoth, skip`);
  }

  const counts = await getCounts(fromPrefix);
  if (counts.truncated || counts.total > MAX_FILES_PER_JOB) {
    throw new TooLargeError(counts.total, MAX_FILES_PER_JOB, counts.truncated);
  }

  const jobId = crypto.randomUUID();
  const record = createJobRecord(jobId, fromPrefix, toPrefix, counts.total, {
    kind: 'merge',
    policy,
  });
  await writeJob(record);

  await enqueueMoveJob({ jobId, fromPrefix, toPrefix, kind: 'merge', policy });
  ctx.log.info('merge job queued', { jobId, fromPrefix, toPrefix, total: counts.total, policy });

  throw new Accepted202({ jobId, status: 'queued' });
}
