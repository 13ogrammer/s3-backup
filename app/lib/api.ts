import { loadConfig, type AppConfig } from './config';

export type ListedFile = {
  key: string;
  size: number;
  lastModified: string;
  kind: 'image' | 'video' | 'other';
  previewUrl?: string;
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
  list: (params: { prefix?: string; continuationToken?: string } = {}) =>
    call<ListResponse>('/list', params),
  signUpload: (key: string, contentType: string) =>
    call<SignedUrlResponse>('/sign-upload', { key, contentType }),
  signDownload: (key: string) => call<SignedUrlResponse>('/sign-download', { key }),
  delete: (params: { keys?: string[]; prefixes?: string[] }) =>
    call<DeleteResponse>('/delete', params),
  exists: (keys: string[]) => call<ExistsResponse>('/exists', { keys }),
  moveFile: (from: string, to: string) =>
    call<MoveResponse>('/move', { kind: 'file', from, to }),
  moveFolder: (fromPrefix: string, toPrefix: string) =>
    call<MoveResponse>('/move', { kind: 'folder', fromPrefix, toPrefix }),
};
