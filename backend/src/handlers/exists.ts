import { HeadObjectCommand } from '@aws-sdk/client-s3';
import { BUCKET, s3, sanitizeKey } from '../s3.js';
import type { ExistsRequest, ExistsResponse } from '../types.js';
import type { RequestContext } from '../index.js';

const PARALLELISM = 16;

export async function exists(body: ExistsRequest, ctx: RequestContext): Promise<ExistsResponse> {
  if (!Array.isArray(body.keys) || body.keys.length === 0) {
    throw new Error('keys must be a non-empty array');
  }

  const keys = body.keys.map(sanitizeKey);
  const existing: string[] = [];

  let cursor = 0;
  async function worker() {
    while (cursor < keys.length) {
      const i = cursor++;
      const key = keys[i]!;
      try {
        await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key }));
        existing.push(key);
      } catch {
        // 404 / NotFound — treat as "doesn't exist". Don't surface S3
        // errors here; the caller will hit them on the actual operation
        // if they really aren't transient.
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(PARALLELISM, keys.length) }, () => worker()),
  );

  ctx.log.info('exists', { checked: keys.length, found: existing.length });
  return { existing };
}
