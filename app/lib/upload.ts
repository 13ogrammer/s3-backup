import {
  FileSystemUploadType,
  createUploadTask,
  deleteAsync,
} from 'expo-file-system/legacy';
import * as ImageManipulator from 'expo-image-manipulator';

import { api } from './api';

const THUMB_MAX_WIDTH = 320;
const THUMB_QUALITY = 0.7;
const THUMB_SUFFIX = '.thumb.jpg';

export type UploadProgress = { bytesSent: number; bytesTotal: number };

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
  if (!result) throw new Error('upload cancelled');
  if (result.status < 200 || result.status >= 300) {
    throw new Error(`upload failed: HTTP ${result.status}`);
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
        await uploadFile(thumb.uri, `${remoteKey}${THUMB_SUFFIX}`, 'image/jpeg');
      } finally {
        await deleteAsync(thumb.uri, { idempotent: true });
      }
    } catch (err) {
      console.warn('thumb generation failed for', remoteKey, err);
    }
  }
  await uploadFile(localUri, remoteKey, contentType, onProgress);
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
