import { loadConfig, type AppConfig } from './config';

/**
 * Curated EXIF/dimensions/GPS bag written as x-amz-meta-* headers on upload.
 * S3B-34: 11 fields max; all values are strings. Absent fields are omitted —
 * never written as empty strings. GPS PII is written by default for this
 * BYO-AWS personal-use card.
 */
export type MetadataBag = {
  width?: string;
  height?: string;
  createdAt?: string;
  make?: string;
  model?: string;
  lens?: string;
  iso?: string;
  aperture?: string;
  shutter?: string;
  lat?: string;
  lng?: string;
};

export type ListedFile = {
  key: string;
  size: number;
  lastModified: string;
  kind: 'image' | 'video' | 'other';
  previewUrl?: string;
  etag?: string;
  // S3B-34: will be populated in S3B-16b via /head fanout; undefined for
  // pre-S3B-34 files and files where head hasn't been fetched yet.
  createdAt?: string;
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

export type MoveFailure = { key: string; reason: string };
export type MoveResponse = {
  moved: number;
  failed?: MoveFailure[]; // omitted when empty; key is always an original key
};

export type JobStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'completed-with-errors'
  | 'cancelled'
  | 'failed';

export type JobRecord = {
  jobId: string;
  kind: 'folder-move';
  fromPrefix: string;
  toPrefix: string;
  status: JobStatus;
  total: number;
  moved: number;
  failed: MoveFailure[];
  cancelRequested?: boolean;
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  error?: string;
  retryOf?: string;
};

export type MoveJobAcceptedResponse = { jobId: string; status: 'queued' };

export type FolderTooLargeErrorBody = {
  error: 'folder-too-large';
  code: 'folder-too-large';
  fileCount: number;
  limit: number;
  truncated: boolean;
};

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
export type FolderCounts = {
  total: number;
  images: number;
  videos: number;
  other: number;
  truncated: boolean;
};
export type FolderPreviewResponse = {
  prefix: string;
  thumbs: FolderPreviewThumb[];
  hasContent: boolean;
  counts?: FolderCounts;
};

export type HeadResponse = {
  sizeBytes: number;
  lastModified: string; // ISO 8601
  metadata?: MetadataBag;
};

export type StorageStats = {
  totalBytes: number;
  totalCount: number;
  estimatedMonthlyUsd: number;
  byType: {
    photos: { bytes: number; count: number };
    videos: { bytes: number; count: number };
    other:  { bytes: number; count: number };
  };
  largeFiles:     Array<{ key: string; sizeBytes: number; lastModified: string }>;
  veryLargeFiles: Array<{ key: string; sizeBytes: number; lastModified: string }>;
  topFolders:     Array<{ prefix: string; bytes: number; count: number }>;
  growth:         Array<{ date: string; bytes: number; count: number }>;
  generatedAt:    string;
  cached:         boolean;
};

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public requestId?: string,
    public body?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export const USER_ACTIONABLE_STATUSES: ReadonlySet<number> = new Set([409]);
export function isUserActionableError(err: unknown): err is ApiError {
  return err instanceof ApiError && USER_ACTIONABLE_STATUSES.has(err.status);
}

export function isFolderTooLargeError(err: unknown): err is ApiError & { body: FolderTooLargeErrorBody } {
  return (
    err instanceof ApiError &&
    err.status === 422 &&
    typeof err.body === 'object' &&
    err.body !== null &&
    (err.body as { code?: string }).code === 'folder-too-large'
  );
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
    const requestId = res.headers.get('x-request-id') ?? undefined;
    let message = `HTTP ${res.status}`;
    let parsedBody: unknown;
    try {
      parsedBody = await res.json();
      const data = parsedBody as { error?: string };
      if (data.error) message = data.error;
    } catch {}
    throw new ApiError(res.status, message, requestId, parsedBody);
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
  signUpload: (key: string, contentType: string, metadata?: MetadataBag) =>
    call<SignedUrlResponse>('/sign-upload', { key, contentType, ...(metadata ? { metadata } : {}) }),
  signDownload: (key: string) => call<SignedUrlResponse>('/sign-download', { key }),
  delete: (params: { keys?: string[]; prefixes?: string[] }) =>
    call<DeleteResponse>('/delete', params),
  exists: (keys: string[]) => call<ExistsResponse>('/exists', { keys }),
  createMultipart: (key: string, contentType: string, metadata?: MetadataBag) =>
    call<CreateMultipartResponse>('/multipart/create', { key, contentType, ...(metadata ? { metadata } : {}) }),
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
    call<MoveJobAcceptedResponse>('/move', { kind: 'folder', fromPrefix, toPrefix }),
  getMoveJob: (jobId: string) =>
    call<JobRecord>('/move-job', { jobId }),
  cancelMoveJob: (jobId: string) =>
    call<{ ok: true; cancelRequested: true }>('/move-job-cancel', { jobId }),
  retryFailedMove: (jobId: string, fromPrefix: string, toPrefix: string, keys: string[]) =>
    call<MoveJobAcceptedResponse>('/move', { kind: 'folder-keys', fromPrefix, toPrefix, keys, retryOfJobId: jobId }),
  getDerivedUrl: (key: string, tier: DerivedTier) =>
    call<GetDerivedUrlResponse | GetDerivedUrlError>('/get-derived-url', { key, tier }),
  folderPreview: (prefix: string) =>
    call<FolderPreviewResponse>('/folder-preview', { prefix }),
  stats: (params: { refresh?: boolean } = {}) =>
    call<StorageStats>('/stats', params),
  head: (key: string): Promise<HeadResponse> => {
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new ApiError(0, 'timeout')), 5000),
    );
    return Promise.race([call<HeadResponse>('/head', { key }), timeout]);
  },
};
