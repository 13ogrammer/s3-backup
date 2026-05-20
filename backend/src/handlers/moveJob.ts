import { readJob, setCancelRequested } from '../jobs.js';
import type { JobRecord, MoveJobCancelRequest, MoveJobCancelResponse, MoveJobGetRequest } from '../types.js';
import type { RequestContext } from '../index.js';

export class JobNotFoundError extends Error {
  constructor(jobId: string) {
    super(`job not found: ${jobId}`);
    this.name = 'JobNotFoundError';
  }
}

export async function getMoveJob(body: MoveJobGetRequest, ctx: RequestContext): Promise<JobRecord> {
  if (!body.jobId || typeof body.jobId !== 'string') throw new Error('jobId is required');
  const record = await readJob(body.jobId);
  if (!record) {
    ctx.log.warn('getMoveJob: not found', { jobId: body.jobId });
    throw new JobNotFoundError(body.jobId);
  }
  return record;
}

export async function cancelMoveJob(
  body: MoveJobCancelRequest,
  ctx: RequestContext,
): Promise<MoveJobCancelResponse> {
  if (!body.jobId || typeof body.jobId !== 'string') throw new Error('jobId is required');
  const record = await setCancelRequested(body.jobId);
  if (!record) {
    ctx.log.warn('cancelMoveJob: not found', { jobId: body.jobId });
    throw new JobNotFoundError(body.jobId);
  }
  ctx.log.info('cancelMoveJob', { jobId: body.jobId });
  return { ok: true, cancelRequested: true };
}
