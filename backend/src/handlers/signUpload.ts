import { PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { toS3Metadata } from '../metadata.js';
import { BUCKET, s3, sanitizeKey } from '../s3.js';
import type { SignUploadRequest, SignUploadResponse } from '../types.js';
import type { RequestContext } from '../index.js';

const EXPIRES_IN = 60 * 60 * 24;

export async function signUpload(body: SignUploadRequest, ctx: RequestContext): Promise<SignUploadResponse> {
  const key = sanitizeKey(body.key);
  if (!body.contentType || typeof body.contentType !== 'string') {
    throw new Error('contentType is required');
  }

  const s3Meta = toS3Metadata(body.metadata);

  const url = await getSignedUrl(
    s3,
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      ContentType: body.contentType,
      Metadata: s3Meta,
    }),
    { expiresIn: EXPIRES_IN },
  );

  // Log keys only — avoid writing GPS coordinates or other PII to logs.
  ctx.log.info('sign-upload', { key, metaKeys: s3Meta ? Object.keys(s3Meta) : [] });
  return { url, expiresIn: EXPIRES_IN, signedAt: Date.now() };
}
