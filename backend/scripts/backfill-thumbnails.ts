/**
 * Optional cache-warming script: walks the bucket and generates a thumbnail
 * for any image that doesn't already have one at
 *   .thumbnails/<stripped-original-key>.thumb.jpg
 *
 * As of S3B-25, the Browse tab generates thumbnails on demand (via
 * /get-derived-url) the first time an image is viewed, so running this
 * script is no longer required. It remains useful as a cache-warming tool:
 * pre-generating thumbs for a large existing bucket avoids the per-image
 * Lambda latency on first browse.
 *
 * Reads the same env vars as the dev server (BUCKET_NAME,
 * S3_ENDPOINT_URL, AWS credentials/region). For MinIO local dev:
 *
 *   set -a && source .env && set +a && npm run backfill:thumbs
 *
 * For real AWS: set BUCKET_NAME and run with your default credential
 * chain (env vars / ~/.aws/credentials / IAM role / etc.).
 *
 * HEIC and other formats sharp can't decode without libheif will be
 * logged and skipped — the on-demand path will return { url: null,
 * error: 'unsupported_format' } for those and the app will degrade
 * gracefully.
 */

import { Readable } from 'node:stream';
import {
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import sharp from 'sharp';

import { classifyKey } from '../src/mediaType.js';
import { BUCKET, s3 } from '../src/s3.js';
import { THUMB_PREFIX, thumbKey } from '../src/thumbs.js';

const THUMB_WIDTH = 320;
const THUMB_QUALITY = 70;
const LIST_PAGE_SIZE = 1000;

async function streamToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer));
  }
  return Buffer.concat(chunks);
}

async function listAllKeys(): Promise<Set<string>> {
  const keys = new Set<string>();
  let continuationToken: string | undefined;
  let page = 0;
  do {
    page += 1;
    const res = await s3.send(
      new ListObjectsV2Command({
        Bucket: BUCKET,
        ContinuationToken: continuationToken,
        MaxKeys: LIST_PAGE_SIZE,
      }),
    );
    for (const obj of res.Contents ?? []) {
      if (obj.Key) keys.add(obj.Key);
    }
    continuationToken = res.IsTruncated ? res.NextContinuationToken : undefined;
    if (page % 5 === 0) console.log(`  scanned ${keys.size} keys…`);
  } while (continuationToken);
  return keys;
}

async function generateThumb(originalKey: string): Promise<void> {
  const obj = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: originalKey }));
  if (!obj.Body) throw new Error('object has no body');
  const buf = await streamToBuffer(obj.Body as Readable);

  const thumb = await sharp(buf)
    .rotate() // honor EXIF orientation
    .resize({ width: THUMB_WIDTH, withoutEnlargement: true })
    .jpeg({ quality: THUMB_QUALITY })
    .toBuffer();

  await s3.send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: thumbKey(originalKey),
      Body: thumb,
      ContentType: 'image/jpeg',
    }),
  );
}

async function main(): Promise<void> {
  if (!BUCKET) {
    console.error('BUCKET_NAME env var is required');
    process.exit(1);
  }

  const endpoint = process.env.S3_ENDPOINT_URL ?? '(real AWS)';
  console.log(`Bucket:   ${BUCKET}`);
  console.log(`Endpoint: ${endpoint}`);
  console.log('Scanning bucket…');

  const allKeys = await listAllKeys();
  console.log(`Total objects: ${allKeys.size}`);

  const todo: string[] = [];
  for (const key of allKeys) {
    if (key.startsWith(THUMB_PREFIX)) continue;
    if (classifyKey(key) !== 'image') continue;
    if (allKeys.has(thumbKey(key))) continue;
    todo.push(key);
  }

  console.log(`Images without thumbs: ${todo.length}`);
  if (todo.length === 0) {
    console.log('Nothing to do. ✓');
    return;
  }

  let done = 0;
  let failed = 0;
  for (const key of todo) {
    try {
      await generateThumb(key);
      done += 1;
      if (done % 10 === 0 || done === todo.length) {
        console.log(`  ${done}/${todo.length}…`);
      }
    } catch (err) {
      failed += 1;
      const message = err instanceof Error ? err.message : 'unknown error';
      console.warn(`  skipped ${key}: ${message}`);
    }
  }

  console.log(`\nDone. ${done} generated, ${failed} failed or skipped.`);
}

main().catch((err) => {
  console.error('backfill failed:', err);
  process.exit(1);
});
