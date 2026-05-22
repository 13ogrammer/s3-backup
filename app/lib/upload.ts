import BackgroundUpload from 'react-native-background-upload';

import {
  EncodingType,
  FileSystemUploadType,
  cacheDirectory,
  createUploadTask,
  deleteAsync,
  getInfoAsync,
  readAsStringAsync,
  writeAsStringAsync,
} from 'expo-file-system/legacy';
import * as ImageManipulator from 'expo-image-manipulator';
import * as VideoThumbnails from 'expo-video-thumbnails';

import { ApiError, api, type CompletedPart, type MetadataBag } from './api';
import { addUploadBreadcrumb } from './sentry';
import {
  removePendingUpload,
  savePendingUpload,
  type PendingMultipartUpload,
  type PendingUpload,
} from './uploadState';

export type MediaKind = 'image' | 'video' | 'other';

export type ResumeState = { uploadId: string; completedParts: CompletedPart[] };

const THUMB_MAX_WIDTH = 320;
const THUMB_QUALITY = 0.7;
const THUMB_PREFIX = '.thumbnails/';
const THUMB_EXT = '.thumb.jpg';

// Files larger than this go through S3 multipart upload so a flaky
// connection only loses the in-flight part, not the whole file.
// 10 MB keeps even mid-sized videos on the resumable path.
const MULTIPART_THRESHOLD = 10 * 1024 * 1024; // 10 MB
// S3 requires every non-final part to be >= 5 MB; up to 10 000 parts.
// 8 MB is a good middle ground — small enough to fit in memory comfortably,
// big enough that even a 10 GB file stays well under the part-count cap.
const MULTIPART_PART_SIZE = 8 * 1024 * 1024;
// S3 single-PUT ceiling. Files at or above this size cannot go through the
// simple (non-multipart) path — MULTIPART_THRESHOLD (10 MB) already routes
// all such files to multipart before they can reach uploadFileSimple, so
// this constant is documentation-only. It exists to make the S3 constraint
// explicit and searchable in the codebase.
const BACKGROUND_MAX_BYTES = 5 * 1024 * 1024 * 1024; // 5 GB

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
  resume?: ResumeState,
  opts?: { trackSimple?: boolean; metadata?: MetadataBag },
): Promise<void> {
  if (resume) {
    // A resume implies the file was previously sized > MULTIPART_THRESHOLD
    // and an uploadId already exists. Metadata was already set on the
    // CreateMultipartUpload call — no need to re-send it here.
    const size = await fileSize(localUri);
    return uploadFileMultipart(localUri, remoteKey, contentType, size, onProgress, resume);
  }
  const size = await fileSize(localUri);
  if (size > MULTIPART_THRESHOLD) {
    return uploadFileMultipart(localUri, remoteKey, contentType, size, onProgress, undefined, opts?.metadata);
  }
  return withRetry(() =>
    uploadFileSimple(localUri, remoteKey, contentType, size, onProgress, opts?.trackSimple ?? false, opts?.metadata),
  );
}

async function uploadFileSimple(
  localUri: string,
  remoteKey: string,
  contentType: string,
  totalBytes: number,
  onProgress?: (progress: UploadProgress) => void,
  trackSimple = false,
  metadata?: MetadataBag,
): Promise<void> {
  addUploadBreadcrumb('upload start', { remoteKey, mode: 'simple', totalBytes });

  // Metadata is embedded in the pre-signed PutObjectCommand — the signed URL
  // covers the x-amz-meta-* headers. RNBU must not send x-amz-meta-* as HTTP
  // headers (MinIO rejects duplicate metadata sources with a 400).
  const { url, signedAt } = await api.signUpload(remoteKey, contentType, metadata);
  addUploadBreadcrumb('sign-upload ok', { remoteKey, mode: 'simple', totalBytes });

  if (trackSimple) {
    await savePendingUpload({
      kind: 'simple',
      localUri,
      remoteKey,
      contentType,
      totalBytes,
      signedAt,
      updatedAt: Date.now(),
    });
  }

  await runRnbuUpload(localUri, remoteKey, contentType, url, onProgress, totalBytes);

  addUploadBreadcrumb('upload complete', { remoteKey, mode: 'simple', totalBytes });

  if (trackSimple) {
    await removePendingUpload(remoteKey).catch(() => undefined);
  }
}

// Hand the upload to react-native-background-upload (RNBU). RNBU uses
// URLSession on iOS and WorkManager on Android, so the transfer continues
// even if the JS thread is paused or the app is backgrounded.
//
// 403 is delivered via the 'completed' event (not 'error') because S3
// returns a well-formed HTTP response. On the first 403 we re-sign and
// retry once; a second 403 is a hard failure.
async function runRnbuUpload(
  localUri: string,
  remoteKey: string,
  contentType: string,
  url: string,
  onProgress: ((progress: UploadProgress) => void) | undefined,
  totalBytes: number,
  isRetry = false,
): Promise<void> {
  addUploadBreadcrumb('RNBU PUT begin', { remoteKey, mode: 'simple', isRetry });

  await new Promise<void>((resolve, reject) => {
    const listeners: Array<{ remove: () => void }> = [];

    function cleanup() {
      for (const l of listeners) l.remove();
    }

    BackgroundUpload.startUpload({
      url,
      path: localUri,
      method: 'PUT',
      type: 'raw',
      headers: { 'content-type': contentType },
      // Stable ID lets us correlate events to this specific upload.
      customUploadId: remoteKey,
      notification: {
        enabled: true,
        autoClear: true,
        notificationChannel: 'background_uploads',
        onProgressTitle: 's3-backup',
        onProgressMessage: 'Uploading',
        onCompleteTitle: 's3-backup',
        onCompleteMessage: 'Upload complete',
        onErrorTitle: 's3-backup',
        onErrorMessage: 'Upload failed',
        onCancelledTitle: 's3-backup',
        onCancelledMessage: 'Upload cancelled',
        enableRingTone: false,
      },
    }).then((uploadId) => {
      listeners.push(
        BackgroundUpload.addListener('progress', (data) => {
          if (data.id !== uploadId) return;
          onProgress?.({ bytesSent: Math.round((data.progress / 100) * totalBytes), bytesTotal: totalBytes });
        }),
      );

      listeners.push(
        BackgroundUpload.addListener('completed', (data) => {
          if (data.id !== uploadId) return;
          cleanup();
          if (data.responseCode >= 200 && data.responseCode < 300) {
            resolve();
          } else if (data.responseCode === 403 && !isRetry) {
            // Re-sign once and retry — the URL may have been generated
            // just before a server-side clock skew or was somehow invalid.
            api.signUpload(remoteKey, contentType)
              .then(({ url: freshUrl }) =>
                runRnbuUpload(localUri, remoteKey, contentType, freshUrl, onProgress, totalBytes, true),
              )
              .then(resolve, reject);
          } else {
            reject(new UploadError(data.responseCode, `upload failed: HTTP ${data.responseCode}`));
          }
        }),
      );

      listeners.push(
        BackgroundUpload.addListener('error', (data) => {
          if (data.id !== uploadId) return;
          cleanup();
          reject(new UploadError(0, `RNBU error: ${data.error}`));
        }),
      );

      listeners.push(
        BackgroundUpload.addListener('cancelled', (data) => {
          if (data.id !== uploadId) return;
          cleanup();
          reject(new UploadError(0, 'upload cancelled'));
        }),
      );
    }).catch((err: unknown) => {
      cleanup();
      reject(err);
    });
  });
}

async function uploadFileMultipart(
  localUri: string,
  remoteKey: string,
  contentType: string,
  totalBytes: number,
  onProgress?: (progress: UploadProgress) => void,
  resume?: ResumeState,
  metadata?: MetadataBag,
): Promise<void> {
  const partSize = MULTIPART_PART_SIZE;
  const partCount = Math.ceil(totalBytes / partSize);
  let uploadId: string;
  const parts: CompletedPart[] = [];
  let bytesSent = 0;

  addUploadBreadcrumb('upload start', {
    remoteKey,
    mode: 'multipart',
    totalBytes,
    partCount,
    resuming: Boolean(resume),
  });

  if (resume) {
    uploadId = resume.uploadId;
    for (const p of resume.completedParts) parts.push(p);
    const completedSet = new Set(parts.map((p) => p.partNumber));
    for (let i = 0; i < partCount; i++) {
      if (!completedSet.has(i + 1)) continue;
      const offset = i * partSize;
      bytesSent += Math.min(partSize, totalBytes - offset);
    }
    onProgress?.({ bytesSent, bytesTotal: totalBytes });
  } else {
    // Metadata is set on CreateMultipartUpload; individual UploadPart calls
    // don't carry Metadata — S3 associates it with the multipart session.
    const created = await withRetry(() => api.createMultipart(remoteKey, contentType, metadata));
    uploadId = created.uploadId;
    // Persist a baseline entry immediately so a failure before the
    // first part still leaves something resumable (and tied to this
    // uploadId, so abort can clean up).
    await savePendingUpload(
      makePending(localUri, remoteKey, contentType, uploadId, totalBytes, partSize, []),
    );
  }

  const completedSet = new Set(parts.map((p) => p.partNumber));

  try {
    for (let i = 0; i < partCount; i++) {
      const partNumber = i + 1;
      if (completedSet.has(partNumber)) continue;
      const offset = i * partSize;
      const length = Math.min(partSize, totalBytes - offset);

      const b64 = await readAsStringAsync(localUri, {
        encoding: EncodingType.Base64,
        position: offset,
        length,
      });

      const { url } = await withRetry(() =>
        api.signPart(remoteKey, uploadId, partNumber),
      );

      // RN's fetch can't accept Uint8Array / ArrayBuffer / Blob-from-typed-array
      // as a request body — the request never leaves the device and surfaces
      // as TypeError "Network request failed". Stage each chunk to a temp file
      // and upload via createUploadTask (NSURLSession on iOS, OkHttp on
      // Android), the same native path simple-PUT uses successfully.
      const tempPath = `${cacheDirectory ?? ''}s3b-part-${uploadId.slice(0, 12)}-${partNumber}`;
      const etag = await withRetry(async () => {
        await writeAsStringAsync(tempPath, b64, { encoding: EncodingType.Base64 });
        try {
          const task = createUploadTask(url, tempPath, {
            httpMethod: 'PUT',
            uploadType: FileSystemUploadType.BINARY_CONTENT,
          });
          const result = await task.uploadAsync();
          if (!result) throw new UploadError(0, `part ${partNumber} upload cancelled`);
          if (result.status < 200 || result.status >= 300) {
            throw new UploadError(result.status, `part ${partNumber} HTTP ${result.status}`);
          }
          const raw = result.headers['etag'] ?? result.headers['ETag'];
          if (!raw) throw new UploadError(0, `part ${partNumber} response had no ETag`);
          return raw.replace(/^"|"$/g, '');
        } finally {
          await deleteAsync(tempPath, { idempotent: true }).catch(() => undefined);
        }
      });

      parts.push({ partNumber, etag });
      bytesSent += length;
      onProgress?.({ bytesSent, bytesTotal: totalBytes });
      addUploadBreadcrumb('part complete', { remoteKey, partNumber, bytesSent, totalBytes });

      // Persist after each successful part so we can resume exactly
      // where we left off if the app is suspended next.
      await savePendingUpload(
        makePending(localUri, remoteKey, contentType, uploadId, totalBytes, partSize, parts),
      ).catch((e) => console.warn('persist multipart state failed', e));
    }

    await withRetry(() => api.completeMultipart(remoteKey, uploadId, parts));
    addUploadBreadcrumb('upload complete', { remoteKey, mode: 'multipart', totalBytes, parts: parts.length });
    await removePendingUpload(remoteKey).catch(() => undefined);
  } catch (err) {
    addUploadBreadcrumb(
      'upload error',
      {
        remoteKey,
        mode: 'multipart',
        retryable: defaultIsRetryable(err),
        message: err instanceof Error ? err.message : String(err),
      },
      'error',
    );
    // Retryable failures (network, 5xx, 429) → keep state and the
    // uploadId so the resume banner can pick up where we left off.
    // Non-retryable (4xx, malformed, etc.) → abort and clear.
    if (defaultIsRetryable(err)) {
      throw err;
    }
    try {
      await api.abortMultipart(remoteKey, uploadId);
    } catch (abortErr) {
      console.warn('multipart abort failed', abortErr);
    }
    await removePendingUpload(remoteKey).catch(() => undefined);
    throw err;
  }
}

function makePending(
  localUri: string,
  remoteKey: string,
  contentType: string,
  uploadId: string,
  totalBytes: number,
  partSize: number,
  completedParts: CompletedPart[],
): PendingMultipartUpload {
  return {
    kind: 'multipart',
    localUri,
    remoteKey,
    contentType,
    uploadId,
    totalBytes,
    partSize,
    completedParts: completedParts.slice(),
    updatedAt: Date.now(),
  };
}

async function fileSize(localUri: string): Promise<number> {
  const info = await getInfoAsync(localUri);
  if (info.exists && 'size' in info && typeof info.size === 'number') {
    return info.size;
  }
  return 0;
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
  metadata?: MetadataBag,
): Promise<void> {
  if (mediaKind === 'image') {
    await generateAndUploadThumb(localUri, remoteKey, 'image');
  } else if (mediaKind === 'video') {
    await generateAndUploadThumb(localUri, remoteKey, 'video');
  }
  // Retries live inside uploadFile now (per-part for multipart, whole-PUT
  // for single). Wrapping again here would mean a multipart retry creates
  // a fresh uploadId and orphans the persisted resume state.
  await uploadFile(localUri, remoteKey, contentType, onProgress, undefined, {
    trackSimple: true,
    metadata,
  });
}

// 23 hours in ms — if the signedAt is older than this, the 24 h URL is
// approaching expiry and we re-sign before attempting the upload.
const RESIGN_THRESHOLD_MS = 23 * 60 * 60 * 1000;

export async function resumeUpload(
  pending: PendingUpload,
  onProgress?: (progress: UploadProgress) => void,
): Promise<void> {
  if (pending.kind === 'simple') {
    const stale = Date.now() - pending.signedAt > RESIGN_THRESHOLD_MS;
    if (stale) {
      // Re-sign before handing off — the stored URL may be near expiry.
      const { url: freshUrl, signedAt: freshSignedAt } = await api.signUpload(
        pending.remoteKey,
        pending.contentType,
      );
      await savePendingUpload({ ...pending, signedAt: freshSignedAt });
      addUploadBreadcrumb('re-signed stale URL', { remoteKey: pending.remoteKey });
      // Fall through to the normal upload path with the fresh URL in the
      // persisted entry; uploadFileSimple will sign again internally, which
      // is one extra /sign-upload call but keeps the code paths simple.
      void freshUrl; // freshUrl is captured in the updated pendingUpload; uploadFileSimple re-signs
    }
    // Re-PUT from zero — no partial state to recover for simple uploads.
    await uploadFile(
      pending.localUri,
      pending.remoteKey,
      pending.contentType,
      onProgress,
      undefined,
      { trackSimple: true },
    );
  } else {
    await uploadFile(pending.localUri, pending.remoteKey, pending.contentType, onProgress, {
      uploadId: pending.uploadId,
      completedParts: pending.completedParts,
    });
  }
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
      if (attempt === maxAttempts || !isRetryable(err)) {
        addUploadBreadcrumb(
          'upload error (giving up)',
          { attempt, message: err instanceof Error ? err.message : String(err) },
          'error',
        );
        throw err;
      }
      addUploadBreadcrumb(
        'retry attempt',
        {
          attempt: attempt + 1,
          maxAttempts,
          message: err instanceof Error ? err.message : String(err),
        },
        'warning',
      );
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
