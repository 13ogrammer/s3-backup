import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  type CompletedPart as S3CompletedPart,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { BUCKET, s3, sanitizeKey } from '../s3.js';
import type {
  AbortMultipartRequest,
  AbortMultipartResponse,
  CompleteMultipartRequest,
  CompleteMultipartResponse,
  CreateMultipartRequest,
  CreateMultipartResponse,
  SignPartRequest,
  SignPartResponse,
} from '../types.js';

const PART_SIGN_TTL = 60 * 60; // 1 hour — enough time to upload a few large parts.

export async function createMultipart(
  body: CreateMultipartRequest,
): Promise<CreateMultipartResponse> {
  const key = sanitizeKey(body.key);
  if (!body.contentType || typeof body.contentType !== 'string') {
    throw new Error('contentType is required');
  }
  const res = await s3.send(
    new CreateMultipartUploadCommand({
      Bucket: BUCKET,
      Key: key,
      ContentType: body.contentType,
    }),
  );
  if (!res.UploadId) throw new Error('S3 returned no UploadId');
  return { uploadId: res.UploadId };
}

export async function signPart(body: SignPartRequest): Promise<SignPartResponse> {
  const key = sanitizeKey(body.key);
  if (!body.uploadId || typeof body.uploadId !== 'string') {
    throw new Error('uploadId is required');
  }
  if (
    !Number.isInteger(body.partNumber) ||
    body.partNumber < 1 ||
    body.partNumber > 10000
  ) {
    throw new Error('partNumber must be an integer between 1 and 10000');
  }
  const url = await getSignedUrl(
    s3,
    new UploadPartCommand({
      Bucket: BUCKET,
      Key: key,
      UploadId: body.uploadId,
      PartNumber: body.partNumber,
    }),
    { expiresIn: PART_SIGN_TTL },
  );
  return { url };
}

export async function completeMultipart(
  body: CompleteMultipartRequest,
): Promise<CompleteMultipartResponse> {
  const key = sanitizeKey(body.key);
  if (!body.uploadId || typeof body.uploadId !== 'string') {
    throw new Error('uploadId is required');
  }
  if (!Array.isArray(body.parts) || body.parts.length === 0) {
    throw new Error('parts must be a non-empty array');
  }
  const parts: S3CompletedPart[] = body.parts
    .slice()
    .sort((a, b) => a.partNumber - b.partNumber)
    .map((p) => ({ PartNumber: p.partNumber, ETag: p.etag }));

  await s3.send(
    new CompleteMultipartUploadCommand({
      Bucket: BUCKET,
      Key: key,
      UploadId: body.uploadId,
      MultipartUpload: { Parts: parts },
    }),
  );
  return { ok: true };
}

export async function abortMultipart(
  body: AbortMultipartRequest,
): Promise<AbortMultipartResponse> {
  const key = sanitizeKey(body.key);
  if (!body.uploadId || typeof body.uploadId !== 'string') {
    throw new Error('uploadId is required');
  }
  await s3.send(
    new AbortMultipartUploadCommand({
      Bucket: BUCKET,
      Key: key,
      UploadId: body.uploadId,
    }),
  );
  return { ok: true };
}
