// On-demand derived asset generation.
//
// ensureDerived(originalKey, tier) checks whether the cached derived asset
// exists (HEAD); if so, returns immediately (cache hit). On a miss it
// downloads the original, resizes with sharp, and PUTs the result.
//
// Spec (locked by Architect):
//   thumbnail: 320 px wide, q=70
//   preview  : 1920 px wide, q=82, withoutEnlargement
//   Both: .rotate() before .resize() to honour EXIF orientation.
//
// Sharp lacks libheif in the standard Lambda build, so HEIC decodes will
// throw. We catch that and surface 'unsupported_format' to the handler.

import { Readable } from 'node:stream';
import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import sharp from 'sharp';
import { BUCKET, s3 } from './s3.js';
import { classifyKey } from './mediaType.js';
import { thumbKey } from './thumbs.js';
import { previewKey } from './previews.js';
import type { DerivedTier } from './types.js';

const THUMB_WIDTH = 320;
const THUMB_QUALITY = 70;

const PREVIEW_WIDTH = 1920;
const PREVIEW_QUALITY = 82;

/** Thrown when the original file is not an image (e.g. video, other). */
export class NotAnImageError extends Error {
  constructor(key: string) {
    super(`derived assets are only generated for images; key is not an image: ${key}`);
    this.name = 'NotAnImageError';
  }
}

/** Thrown when sharp cannot decode the format (e.g. HEIC without libheif). */
export class UnsupportedFormatError extends Error {
  constructor(cause?: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(`unsupported image format: ${detail}`);
    this.name = 'UnsupportedFormatError';
  }
}

function derivedKey(originalKey: string, tier: DerivedTier): string {
  return tier === 'thumbnail' ? thumbKey(originalKey) : previewKey(originalKey);
}

async function headExists(key: string): Promise<boolean> {
  try {
    await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key }));
    return true;
  } catch {
    return false;
  }
}

async function streamToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer));
  }
  return Buffer.concat(chunks);
}

/**
 * Ensures the derived asset for `originalKey` at `tier` exists in S3.
 * Returns `{ generated: boolean }` — true if this call produced the asset,
 * false if it was already cached.
 *
 * Throws `NotAnImageError` when the key is not classified as an image.
 * Throws `UnsupportedFormatError` when sharp cannot decode the original.
 */
export async function ensureDerived(
  originalKey: string,
  tier: DerivedTier,
): Promise<{ derivedKey: string; generated: boolean }> {
  if (classifyKey(originalKey) !== 'image') {
    throw new NotAnImageError(originalKey);
  }

  const dKey = derivedKey(originalKey, tier);

  // Cache hit — nothing to generate.
  if (await headExists(dKey)) {
    return { derivedKey: dKey, generated: false };
  }

  // Cache miss — download original, resize, put derived.
  const obj = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: originalKey }));
  if (!obj.Body) throw new Error('object has no body');

  const buf = await streamToBuffer(obj.Body as Readable);

  let resized: Buffer;
  try {
    const pipeline = sharp(buf).rotate();
    if (tier === 'thumbnail') {
      resized = await pipeline
        .resize({ width: THUMB_WIDTH })
        .jpeg({ quality: THUMB_QUALITY })
        .toBuffer();
    } else {
      resized = await pipeline
        .resize({ width: PREVIEW_WIDTH, withoutEnlargement: true })
        .jpeg({ quality: PREVIEW_QUALITY })
        .toBuffer();
    }
  } catch (err) {
    // Sharp throws on unsupported formats (e.g. HEIC without libheif).
    throw new UnsupportedFormatError(err);
  }

  await s3.send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: dKey,
      Body: resized,
      ContentType: 'image/jpeg',
    }),
  );

  return { derivedKey: dKey, generated: true };
}
