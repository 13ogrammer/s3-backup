import { loadConfig, type AppConfig } from './config';

export type ListedFile = {
  key: string;
  size: number;
  lastModified: string;
  kind: 'image' | 'video' | 'other';
  previewUrl?: string;
  etag?: string;
};

export type ListResponse = {
  prefix: string;
  folders: string[];
  files: ListedFile[];
  nextToken?: string;
};

export type SignedUrlResponse = { url: string; expiresIn: number };

export type DeleteResponse = {
  deleted: string[];
  errors: Array<{ key: string; message: string }>;
};

export type MoveResponse = { moved: number };

export type ExistsResponse = { existing: string[] };

export type CreateMultipartResponse = { uploadId: string };
export type SignPartResponse = { url: string };
export type CompletedPart = { partNumber: number; etag: string };

export type RestoreResponse = { restored: string[]; missing: string[] };

export type DerivedTier = 'thumbnail' | 'preview';
export type GetDerivedUrlResponse = {
  url: string;
  expiresIn: number;
  tier: DerivedTier;
  generated: boolean;
};
export type GetDerivedUrlError = { url: null; error: string };

export type FolderPreviewThumb = {
  key: string;
  url: string;
  kind: 'image' | 'video';
};
export type FolderPreviewResponse = {
  prefix: string;
  thumbs: FolderPreviewThumb[];
  hasContent: boolean;
};

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = 'ApiError';
  }
}

async function call<T>(path: string, body: unknown, configOverride?: AppConfig): Promise<T> {
  const config = configOverride ?? (await loadConfig());
  if (!config) throw new ApiError(0, 'Backend URL + token not configured. Open Settings.');

  const res = await fetch(`${config.backendUrl}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${config.bootstrapToken}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    try {
      const data = (await res.json()) as { error?: string };
      if (data.error) message = data.error;
    } catch {}
    throw new ApiError(res.status, message);
  }

  return (await res.json()) as T;
}

export async function healthCheck(config: AppConfig): Promise<boolean> {
  const res = await fetch(`${config.backendUrl}/health`);
  return res.ok;
}

export const api = {
  list: (params: { prefix?: string; continuationToken?: string; recursive?: boolean } = {}) =>
    call<ListResponse>('/list', params),
  signUpload: (key: string, contentType: string) =>
    call<SignedUrlResponse>('/sign-upload', { key, contentType }),
  signDownload: (key: string) => call<SignedUrlResponse>('/sign-download', { key }),
  delete: (params: { keys?: string[]; prefixes?: string[] }) =>
    call<DeleteResponse>('/delete', params),
  exists: (keys: string[]) => call<ExistsResponse>('/exists', { keys }),
  createMultipart: (key: string, contentType: string) =>
    call<CreateMultipartResponse>('/multipart/create', { key, contentType }),
  signPart: (key: string, uploadId: string, partNumber: number) =>
    call<SignPartResponse>('/multipart/sign-part', { key, uploadId, partNumber }),
  completeMultipart: (key: string, uploadId: string, parts: CompletedPart[]) =>
    call<{ ok: true }>('/multipart/complete', { key, uploadId, parts }),
  abortMultipart: (key: string, uploadId: string) =>
    call<{ ok: true }>('/multipart/abort', { key, uploadId }),
  restore: (keys: string[]) => call<RestoreResponse>('/restore', { keys }),
  moveFile: (from: string, to: string) =>
    call<MoveResponse>('/move', { kind: 'file', from, to }),
  moveFolder: (fromPrefix: string, toPrefix: string) =>
    call<MoveResponse>('/move', { kind: 'folder', fromPrefix, toPrefix }),
  getDerivedUrl: (key: string, tier: DerivedTier) =>
    call<GetDerivedUrlResponse | GetDerivedUrlError>('/get-derived-url', { key, tier }),
  folderPreview: (prefix: string) =>
    call<FolderPreviewResponse>('/folder-preview', { prefix }),
};
