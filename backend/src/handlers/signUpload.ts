import { PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { BUCKET, s3, sanitizeKey } from '../s3.js';
import type { SignUploadRequest, SignUploadResponse } from '../types.js';
import type { RequestContext } from '../index.js';

const EXPIRES_IN = 60 * 15;

export async function signUpload(body: SignUploadRequest, ctx: RequestContext): Promise<SignUploadResponse> {
  const key = sanitizeKey(body.key);
  if (!body.contentType || typeof body.contentType !== 'string') {
    throw new Error('contentType is required');
  }

  const url = await getSignedUrl(
    s3,
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      ContentType: body.contentType,
    }),
    { expiresIn: EXPIRES_IN },
  );

  ctx.log.info('sign-upload', { key });
  return { url, expiresIn: EXPIRES_IN };
}
