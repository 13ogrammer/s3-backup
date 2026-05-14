import {
  EncodingType,
  FileSystemUploadType,
  createUploadTask,
  deleteAsync,
  getInfoAsync,
  readAsStringAsync,
} from 'expo-file-system/legacy';
import * as ImageManipulator from 'expo-image-manipulator';
import * as VideoThumbnails from 'expo-video-thumbnails';

import { ApiError, api, type CompletedPart } from './api';

export type MediaKind = 'image' | 'video' | 'other';

const THUMB_MAX_WIDTH = 320;
const THUMB_QUALITY = 0.7;
const THUMB_PREFIX = '.thumbnails/';
const THUMB_EXT = '.thumb.jpg';

// Files larger than this go through S3 multipart upload so a flaky
// connection only loses the in-flight part, not the whole file.
const MULTIPART_THRESHOLD = 50 * 1024 * 1024; // 50 MB
// S3 requires every non-final part to be >= 5 MB; up to 10 000 parts.
// 8 MB is a good middle ground — small enough to fit in memory comfortably,
// big enough that even a 10 GB file stays well under the part-count cap.
const MULTIPART_PART_SIZE = 8 * 1024 * 1024;

function stripExt(key: string): string {
  const slashIdx = key.lastIndexOf('/');
  const dotIdx = key.lastIndexOf('.');
  if (dotIdx <= slashIdx) return key;
  return key.slice(0, dotIdx);
}

export type UploadProgress = { bytesSent: number; bytesTotal: number };

export class UploadError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = 'UploadError';
  }
}

export async function uploadFile(
  localUri: string,
  remoteKey: string,
  contentType: string,
  onProgress?: (progress: UploadProgress) => void,
): Promise<void> {
  const size = await fileSize(localUri);
  if (size > MULTIPART_THRESHOLD) {
    return uploadFileMultipart(localUri, remoteKey, contentType, size, onProgress);
  }
  return uploadFileSimple(localUri, remoteKey, contentType, onProgress);
}

async function uploadFileSimple(
  localUri: string,
  remoteKey: string,
  contentType: string,
  onProgress?: (progress: UploadProgress) => void,
): Promise<void> {
  const { url } = await api.signUpload(remoteKey, contentType);

  const task = createUploadTask(
    url,
    localUri,
    {
      httpMethod: 'PUT',
      uploadType: FileSystemUploadType.BINARY_CONTENT,
      headers: { 'content-type': contentType },
    },
    (data) => {
      onProgress?.({
        bytesSent: data.totalBytesSent,
        bytesTotal: data.totalBytesExpectedToSend,
      });
    },
  );

  const result = await task.uploadAsync();
  if (!result) throw new UploadError(0, 'upload cancelled');
  if (result.status < 200 || result.status >= 300) {
    throw new UploadError(result.status, `upload failed: HTTP ${result.status}`);
  }
}

async function uploadFileMultipart(
  localUri: string,
  remoteKey: string,
  contentType: string,
  totalBytes: number,
  onProgress?: (progress: UploadProgress) => void,
): Promise<void> {
  const { uploadId } = await withRetry(() => api.createMultipart(remoteKey, contentType));
  const partCount = Math.ceil(totalBytes / MULTIPART_PART_SIZE);
  const parts: CompletedPart[] = [];
  let bytesSent = 0;

  try {
    for (let i = 0; i < partCount; i++) {
      const partNumber = i + 1;
      const offset = i * MULTIPART_PART_SIZE;
      const length = Math.min(MULTIPART_PART_SIZE, totalBytes - offset);

      const b64 = await readAsStringAsync(localUri, {
        encoding: EncodingType.Base64,
        position: offset,
        length,
      });
      const bytes = base64ToBytes(b64);

      const { url } = await withRetry(() =>
        api.signPart(remoteKey, uploadId, partNumber),
      );

      const etag = await withRetry(async () => {
        // RN's fetch accepts a typed-array body at runtime; the TS lib
        // type doesn't list Uint8Array, hence the cast.
        const res = await fetch(url, {
          method: 'PUT',
          body: bytes as unknown as BodyInit,
        });
        if (!res.ok) {
          throw new UploadError(res.status, `part ${partNumber} HTTP ${res.status}`);
        }
        const raw = res.headers.get('etag') ?? res.headers.get('ETag');
        if (!raw) throw new UploadError(0, `part ${partNumber} response had no ETag`);
        return raw.replace(/^"|"$/g, '');
      });

      parts.push({ partNumber, etag });
      bytesSent += length;
      onProgress?.({ bytesSent, bytesTotal: totalBytes });
    }

    await withRetry(() => api.completeMultipart(remoteKey, uploadId, parts));
  } catch (err) {
    // Best-effort abort so we don't leave dangling multipart uploads
    // racking up storage charges. Failures here are swallowed because
    // the user already has the original error.
    try {
      await api.abortMultipart(remoteKey, uploadId);
    } catch (abortErr) {
      console.warn('multipart abort failed', abortErr);
    }
    throw err;
  }
}

async function fileSize(localUri: string): Promise<number> {
  const info = await getInfoAsync(localUri);
  if (info.exists && 'size' in info && typeof info.size === 'number') {
    return info.size;
  }
  return 0;
}

function base64ToBytes(b64: string): Uint8Array {
  // Native atob is available on Hermes / JSC. Fast enough for 8 MB chunks.
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// Upload an asset to S3, plus a small thumb sidecar for images and
// videos. The thumb upload is best-effort — if it fails (e.g. the video
// codec can't be decoded for a frame grab), the original still uploads
// and the app falls back to a placeholder tile for that file.
export async function uploadAsset(
  localUri: string,
  remoteKey: string,
  contentType: string,
  mediaKind: MediaKind,
  onProgress?: (progress: UploadProgress) => void,
): Promise<void> {
  if (mediaKind === 'image') {
    await generateAndUploadThumb(localUri, remoteKey, 'image');
  } else if (mediaKind === 'video') {
    await generateAndUploadThumb(localUri, remoteKey, 'video');
  }
  await withRetry(() => uploadFile(localUri, remoteKey, contentType, onProgress));
}

async function generateAndUploadThumb(
  sourceUri: string,
  remoteKey: string,
  kind: 'image' | 'video',
): Promise<void> {
  try {
    let frameUri = sourceUri;
    let cleanupFrame = false;
    if (kind === 'video') {
      const frame = await VideoThumbnails.getThumbnailAsync(sourceUri, {
        time: 1000,
        quality: 0.7,
      });
      frameUri = frame.uri;
      cleanupFrame = true;
    }
    try {
      const thumb = await ImageManipulator.manipulateAsync(
        frameUri,
        [{ resize: { width: THUMB_MAX_WIDTH } }],
        { compress: THUMB_QUALITY, format: ImageManipulator.SaveFormat.JPEG },
      );
      try {
        await withRetry(() =>
          uploadFile(
            thumb.uri,
            `${THUMB_PREFIX}${stripExt(remoteKey)}${THUMB_EXT}`,
            'image/jpeg',
          ),
        );
      } finally {
        await deleteAsync(thumb.uri, { idempotent: true });
      }
    } finally {
      if (cleanupFrame) await deleteAsync(frameUri, { idempotent: true });
    }
  } catch (err) {
    console.warn('thumb generation failed for', remoteKey, err);
  }
}

type RetryOptions = {
  maxAttempts?: number;
  baseDelayMs?: number;
  isRetryable?: (err: unknown) => boolean;
};

export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: RetryOptions = {},
): Promise<T> {
  const maxAttempts = opts.maxAttempts ?? 3;
  const baseDelay = opts.baseDelayMs ?? 1000;
  const isRetryable = opts.isRetryable ?? defaultIsRetryable;

  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt === maxAttempts || !isRetryable(err)) throw err;
      // Exponential backoff with jitter: ~baseDelay * 2^(n-1), ±50%.
      const delay = baseDelay * Math.pow(2, attempt - 1) * (0.5 + Math.random());
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

function defaultIsRetryable(err: unknown): boolean {
  if (err instanceof UploadError) {
    if (err.status === 0) return false; // user cancelled
    if (err.status === 408 || err.status === 429) return true;
    if (err.status >= 500 && err.status < 600) return true;
    return false;
  }
  if (err instanceof ApiError) {
    if (err.status === 0) return true; // network/no-config
    if (err.status === 408 || err.status === 429) return true;
    if (err.status >= 500 && err.status < 600) return true;
    return false;
  }
  if (err instanceof TypeError) return true; // fetch network error
  if (err instanceof Error && /network|timeout|abort|reset|ECONN/i.test(err.message)) {
    return true;
  }
  return false;
}

// Run an async worker over a list of items with bounded concurrency.
// Returns the items that failed (after retries inside the worker).
export async function runWithConcurrency<T>(
  items: T[],
  worker: (item: T, index: number) => Promise<void>,
  concurrency: number,
): Promise<Array<{ item: T; error: unknown }>> {
  const failed: Array<{ item: T; error: unknown }> = [];
  let cursor = 0;
  async function loop() {
    while (cursor < items.length) {
      const i = cursor++;
      const item = items[i]!;
      try {
        await worker(item, i);
      } catch (err) {
        failed.push({ item, error: err });
      }
    }
  }
  const n = Math.min(Math.max(1, concurrency), items.length);
  await Promise.all(Array.from({ length: n }, () => loop()));
  return failed;
}

const CONTENT_TYPE_BY_EXT: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  heic: 'image/heic',
  heif: 'image/heif',
  webp: 'image/webp',
  gif: 'image/gif',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  m4v: 'video/x-m4v',
  avi: 'video/x-msvideo',
  mkv: 'video/x-matroska',
};

export function inferContentType(filename: string, mediaType: string): string {
  const ext = filename.toLowerCase().split('.').pop() ?? '';
  const mapped = CONTENT_TYPE_BY_EXT[ext];
  if (mapped) return mapped;
  if (mediaType === 'photo') return 'image/jpeg';
  if (mediaType === 'video' || mediaType === 'pairedVideo') return 'video/mp4';
  return 'application/octet-stream';
}
