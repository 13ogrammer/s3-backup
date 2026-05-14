import {
  FileSystemUploadType,
  createUploadTask,
  deleteAsync,
} from 'expo-file-system/legacy';
import * as ImageManipulator from 'expo-image-manipulator';

import { ApiError, api } from './api';

const THUMB_MAX_WIDTH = 320;
const THUMB_QUALITY = 0.7;
const THUMB_PREFIX = '.thumbnails/';
const THUMB_EXT = '.thumb.jpg';

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

// Upload an asset to S3, plus a small thumb sidecar for images.
// The thumb upload is best-effort — if it fails, the original still uploads
// and the app falls back to using the original for thumbnails.
export async function uploadAsset(
  localUri: string,
  remoteKey: string,
  contentType: string,
  isImage: boolean,
  onProgress?: (progress: UploadProgress) => void,
): Promise<void> {
  if (isImage) {
    try {
      const thumb = await ImageManipulator.manipulateAsync(
        localUri,
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
    } catch (err) {
      console.warn('thumb generation failed for', remoteKey, err);
    }
  }
  await withRetry(() => uploadFile(localUri, remoteKey, contentType, onProgress));
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
