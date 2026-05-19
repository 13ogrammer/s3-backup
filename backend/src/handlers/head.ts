import { HeadObjectCommand } from '@aws-sdk/client-s3';
import { fromS3Metadata } from '../metadata.js';
import { BUCKET, s3, sanitizeKey } from '../s3.js';
import type { HeadRequest, HeadResponse } from '../types.js';
import type { RequestContext } from '../index.js';

export async function head(body: HeadRequest, ctx: RequestContext): Promise<HeadResponse> {
  const key = sanitizeKey(body.key);

  const result = await s3.send(
    new HeadObjectCommand({ Bucket: BUCKET, Key: key }),
  );

  const sizeBytes = result.ContentLength ?? 0;
  const lastModified = (result.LastModified ?? new Date()).toISOString();
  const metadata = fromS3Metadata(result.Metadata);

  ctx.log.info('head', { key, sizeBytes, hasMetadata: metadata != null });

  const response: HeadResponse = { sizeBytes, lastModified };
  if (metadata !== undefined) response.metadata = metadata;
  return response;
}
