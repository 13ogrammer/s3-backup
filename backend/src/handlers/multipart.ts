import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  type CompletedPart as S3CompletedPart,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { toS3Metadata } from '../metadata.js';
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
import type { RequestContext } from '../index.js';

const PART_SIGN_TTL = 60 * 60; // 1 hour — enough time to upload a few large parts.

export async function createMultipart(
  body: CreateMultipartRequest,
  ctx: RequestContext,
): Promise<CreateMultipartResponse> {
  const key = sanitizeKey(body.key);
  if (!body.contentType || typeof body.contentType !== 'string') {
    throw new Error('contentType is required');
  }

  const s3Meta = toS3Metadata(body.metadata);

  const res = await s3.send(
    new CreateMultipartUploadCommand({
      Bucket: BUCKET,
      Key: key,
      ContentType: body.contentType,
      Metadata: s3Meta,
    }),
  );
  if (!res.UploadId) throw new Error('S3 returned no UploadId');
  // Log keys only — avoid writing GPS coordinates or other PII to logs.
  ctx.log.info('multipart-create', { key, metaKeys: s3Meta ? Object.keys(s3Meta) : [] });
  return { uploadId: res.UploadId };
}

export async function signPart(body: SignPartRequest, ctx: RequestContext): Promise<SignPartResponse> {
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
  ctx.log.info('multipart-sign-part', { key, partNumber: body.partNumber });
  return { url };
}

export async function completeMultipart(
  body: CompleteMultipartRequest,
  ctx: RequestContext,
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
  ctx.log.info('multipart-complete', { key, partCount: parts.length });
  return { ok: true };
}

export async function abortMultipart(
  body: AbortMultipartRequest,
  ctx: RequestContext,
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
  ctx.log.info('multipart-abort', { key });
  return { ok: true };
}
