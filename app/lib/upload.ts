import {
  FileSystemUploadType,
  createUploadTask,
} from 'expo-file-system/legacy';

import { api } from './api';

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
