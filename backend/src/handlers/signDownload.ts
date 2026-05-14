import { GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { BUCKET, s3, sanitizeKey } from '../s3.js';
import type { SignDownloadRequest, SignDownloadResponse } from '../types.js';

const EXPIRES_IN = 60 * 10;

export async function signDownload(body: SignDownloadRequest): Promise<SignDownloadResponse> {
  const key = sanitizeKey(body.key);

  const url = await getSignedUrl(
    s3,
    new GetObjectCommand({ Bucket: BUCKET, Key: key }),
    { expiresIn: EXPIRES_IN },
  );

  return { url, expiresIn: EXPIRES_IN };
}
