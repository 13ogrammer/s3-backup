import { readJob, setCancelRequested } from '../jobs.js';
import type { JobRecord, MoveJobCancelRequest, MoveJobCancelResponse, MoveJobGetRequest } from '../types.js';
import type { RequestContext } from '../index.js';

// Matches the output of crypto.randomUUID(): 8-4-4-4-12 hex groups.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class JobNotFoundError extends Error {
  constructor(jobId: string) {
    super(`job not found: ${jobId}`);
    this.name = 'JobNotFoundError';
  }
}

export class InvalidJobIdError extends Error {
  constructor() {
    super('jobId must be a valid UUID');
    this.name = 'InvalidJobIdError';
  }
}

function validateJobId(raw: unknown): string {
  if (!raw || typeof raw !== 'string' || !UUID_RE.test(raw)) {
    throw new InvalidJobIdError();
  }
  return raw;
}

export async function getMoveJob(body: MoveJobGetRequest, ctx: RequestContext): Promise<JobRecord> {
  const jobId = validateJobId(body.jobId);
  const record = await readJob(jobId);
  if (!record) {
    ctx.log.warn('getMoveJob: not found', { jobId });
    throw new JobNotFoundError(jobId);
  }
  return record;
}

export async function cancelMoveJob(
  body: MoveJobCancelRequest,
  ctx: RequestContext,
): Promise<MoveJobCancelResponse> {
  const jobId = validateJobId(body.jobId);
  const record = await setCancelRequested(jobId);
  if (!record) {
    ctx.log.warn('cancelMoveJob: not found', { jobId });
    throw new JobNotFoundError(jobId);
  }
  ctx.log.info('cancelMoveJob', { jobId });
  return { ok: true, cancelRequested: true };
}
