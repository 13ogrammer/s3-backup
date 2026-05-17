/**
 * One-shot operator tool: walks the bucket and generates a thumbnail for
 * every video key that does not already have a sidecar at
 *   .thumbnails/<stripped-key>.thumb.jpg
 *
 * PREREQUISITES
 *   ffmpeg must be on PATH (or set FFMPEG_BIN to the full path).
 *   Install: `brew install ffmpeg` (macOS) / `apt-get install ffmpeg` (Linux)
 *
 * ENV VARS
 *   BUCKET_NAME          Required. S3 bucket to scan.
 *   AWS_REGION           Optional (default: us-east-1).
 *   S3_ENDPOINT_URL      Optional. Set for MinIO or any S3-compatible endpoint.
 *   FFMPEG_BIN           Optional. Path to ffmpeg binary (default: "ffmpeg").
 *
 * HOW TO RUN
 *   cd backend && npm run backfill:video-thumbs
 *   For MinIO local dev:  set -a && source .env && set +a && npm run backfill:video-thumbs
 *   For real AWS: set BUCKET_NAME (and AWS credentials in env / ~/.aws) then run.
 *
 * Safe to re-run: keys with existing sidecars are skipped.
 * Runs serially — predictable log output, minimal concurrent S3 pressure.
 * Not in the runtime path; never called by Lambda.
 */

import { createWriteStream } from 'node:fs';
import { unlink } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { spawnSync, spawn } from 'node:child_process';
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

const FFMPEG_BIN = process.env.FFMPEG_BIN ?? 'ffmpeg';
const THUMB_WIDTH = 320;
const THUMB_QUALITY = 70;
const FRAME_TIMESTAMP_SEC = 1;
const LIST_PAGE_SIZE = 1000;

// ─── helpers ────────────────────────────────────────────────────────────────

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

/**
 * Stream an S3 object body to a temp file on disk.
 * Videos can be 500 MB — never buffer them in memory.
 */
async function streamObjectToTempFile(key: string): Promise<string> {
  const obj = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
  if (!obj.Body) throw new Error('object has no body');

  const ext = path.extname(key) || '.video';
  const tmpPath = path.join(os.tmpdir(), `bfvt-${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);

  await pipeline(obj.Body as Readable, createWriteStream(tmpPath));
  return tmpPath;
}

/**
 * Run ffmpeg with input-seek (-ss before -i) for fast seek on large videos,
 * extract a single frame, pipe raw JPEG bytes to stdout.
 */
function extractFrameWithFfmpeg(tmpVideoPath: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const ff = spawn(FFMPEG_BIN, [
      '-nostdin',
      '-loglevel', 'error',
      '-ss', String(FRAME_TIMESTAMP_SEC),
      '-i', tmpVideoPath,
      '-frames:v', '1',
      '-f', 'image2',
      '-vcodec', 'mjpeg',
      'pipe:1',
    ]);

    const chunks: Buffer[] = [];
    ff.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));

    let stderr = '';
    ff.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });

    ff.on('error', reject);
    ff.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`ffmpeg exited ${code}: ${stderr.trim()}`));
      } else if (chunks.length === 0) {
        // Short clip shorter than FRAME_TIMESTAMP_SEC — ffmpeg succeeds with no output.
        // Fall back to frame at position 0.
        const ff0 = spawn(FFMPEG_BIN, [
          '-nostdin',
          '-loglevel', 'error',
          '-i', tmpVideoPath,
          '-frames:v', '1',
          '-f', 'image2',
          '-vcodec', 'mjpeg',
          'pipe:1',
        ]);
        const chunks0: Buffer[] = [];
        ff0.stdout.on('data', (c: Buffer) => chunks0.push(c));
        let stderr0 = '';
        ff0.stderr.on('data', (d: Buffer) => { stderr0 += d.toString(); });
        ff0.on('error', reject);
        ff0.on('close', (code0) => {
          if (code0 !== 0) {
            reject(new Error(`ffmpeg fallback exited ${code0}: ${stderr0.trim()}`));
          } else {
            resolve(Buffer.concat(chunks0));
          }
        });
      } else {
        resolve(Buffer.concat(chunks));
      }
    });
  });
}

/**
 * Orchestrate: stream video → extract frame → sharp resize → PutObject.
 */
async function generateVideoThumb(originalKey: string): Promise<void> {
  let tmpVideoPath: string | undefined;
  try {
    tmpVideoPath = await streamObjectToTempFile(originalKey);

    const rawFrame = await extractFrameWithFfmpeg(tmpVideoPath);

    const thumb = await sharp(rawFrame)
      .rotate() // honor EXIF/container orientation
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
  } finally {
    if (tmpVideoPath) {
      await unlink(tmpVideoPath).catch(() => { /* best-effort cleanup */ });
    }
  }
}

// ─── main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // Fail fast: check BUCKET_NAME before touching S3.
  if (!BUCKET) {
    console.error('BUCKET_NAME env var is required');
    process.exit(1);
  }

  // Fail fast: verify ffmpeg is available before listing the bucket.
  const ffCheck = spawnSync(FFMPEG_BIN, ['-version'], { stdio: 'ignore' });
  if (ffCheck.error || ffCheck.status !== 0) {
    console.error(`ffmpeg not found at "${FFMPEG_BIN}".`);
    console.error('Install: brew install ffmpeg  (macOS) / apt-get install ffmpeg  (Linux)');
    console.error('Or set FFMPEG_BIN to the full path of your ffmpeg binary.');
    process.exit(1);
  }

  const endpoint = process.env.S3_ENDPOINT_URL ?? '(real AWS)';
  console.log(`Bucket:   ${BUCKET}`);
  console.log(`Endpoint: ${endpoint}`);
  console.log(`ffmpeg:   ${FFMPEG_BIN}`);
  console.log('Scanning bucket…');

  const allKeys = await listAllKeys();
  console.log(`Total objects: ${allKeys.size}`);

  const todo: string[] = [];
  for (const key of allKeys) {
    if (key.startsWith(THUMB_PREFIX)) continue;
    if (classifyKey(key) !== 'video') continue;
    if (allKeys.has(thumbKey(key))) continue; // sidecar already exists
    todo.push(key);
  }

  console.log(`Videos without thumbs: ${todo.length}`);
  if (todo.length === 0) {
    console.log('Nothing to do. ✓');
    return;
  }

  let processed = 0;
  let skipped = 0;
  let failed = 0;

  for (const key of todo) {
    try {
      await generateVideoThumb(key);
      processed += 1;
      if (processed % 10 === 0 || processed === todo.length) {
        console.log(`  ${processed}/${todo.length}…`);
      }
    } catch (err) {
      failed += 1;
      const message = err instanceof Error ? err.message : 'unknown error';
      console.warn(`  failed ${key}: ${message}`);
    }
  }

  console.log(`\nDone. ${processed} generated, ${skipped} skipped, ${failed} failed.`);
}

main().catch((err) => {
  console.error('backfill-video-thumbs failed:', err);
  process.exit(1);
});
