export type ListRequest = { prefix?: string; continuationToken?: string; recursive?: boolean };
export type ListedFile = {
  key: string;
  size: number;
  lastModified: string;
  kind: 'image' | 'video' | 'other';
  previewUrl?: string;
  etag?: string;
  // S3B-34: populated in future S3B-16b via /head fanout; undefined for files
  // uploaded before S3B-34 and for pre-S3B-34 objects (no metadata on S3 object).
  createdAt?: string;
};
export type ListResponse = {
  prefix: string;
  folders: string[];
  files: ListedFile[];
  nextToken?: string;
  // Set when the first /list call hit MAX_FOLDER_DISCOVERY_PAGES before
  // exhausting CommonPrefixes. Remaining folders surface during file
  // pagination as the client scrolls. Omitted (undefined) in the common case.
  foldersTruncated?: boolean;
};

/**
 * Curated EXIF/dimensions/GPS bag written as x-amz-meta-* headers on upload.
 * S3B-34: total metadata budget is 2 KB. With 11 fields at max 100 chars each
 * the ceiling is ~1.1 KB key+value pairs — well within the 2 KB S3 limit.
 * Absent fields are not written as empty strings. GPS PII written by default
 * for this BYO-AWS personal-use card (opt-in deferred to a future card).
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

export type SignUploadRequest = { key: string; contentType: string; metadata?: MetadataBag };
export type SignUploadResponse = { url: string; expiresIn: number; signedAt: number };

export type SignDownloadRequest = { key: string };
export type SignDownloadResponse = { url: string; expiresIn: number };

export type DeleteRequest = { keys?: string[]; prefixes?: string[] };
export type DeleteResponse = { deleted: string[]; errors: Array<{ key: string; message: string }> };

export type MoveRequest =
  | { kind: 'file'; from: string; to: string }
  | { kind: 'folder'; fromPrefix: string; toPrefix: string }
  | { kind: 'folder-keys'; fromPrefix: string; toPrefix: string; keys: string[]; retryOfJobId?: string };
export type MoveFailure = { key: string; reason: string };
export type MoveResponse = {
  moved: number;
  failed?: MoveFailure[]; // omitted when empty; key is always an original key
};

export type MoveJobAcceptedResponse = { jobId: string; status: 'queued' };

export type FolderTooLargeError = {
  error: 'folder-too-large';
  code: 'folder-too-large';
  fileCount: number;
  limit: number;
  truncated: boolean;
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

export type MoveJobMessage = {
  jobId: string;
  fromPrefix: string;
  toPrefix: string;
  keys?: string[];
};

export type MoveJobGetRequest = { jobId: string };
export type MoveJobCancelRequest = { jobId: string };
export type MoveJobCancelResponse = { ok: true; cancelRequested: true };

export type ExistsRequest = { keys: string[] };
export type ExistsResponse = { existing: string[] };

export type CreateMultipartRequest = { key: string; contentType: string; metadata?: MetadataBag };
export type CreateMultipartResponse = { uploadId: string };

export type SignPartRequest = { key: string; uploadId: string; partNumber: number };
export type SignPartResponse = { url: string };

export type CompletedPart = { partNumber: number; etag: string };

export type CompleteMultipartRequest = {
  key: string;
  uploadId: string;
  parts: CompletedPart[];
};
export type CompleteMultipartResponse = { ok: true };

export type AbortMultipartRequest = { key: string; uploadId: string };
export type AbortMultipartResponse = { ok: true };

export type RestoreRequest = { keys: string[] };
export type RestoreResponse = { restored: string[]; missing: string[] };

export type DerivedTier = 'thumbnail' | 'preview';
export type GetDerivedUrlRequest = { key: string; tier: DerivedTier };
export type GetDerivedUrlResponse = {
  url: string;
  expiresIn: number;
  tier: DerivedTier;
  /** true when this request generated the derived asset; false when it was a cache hit */
  generated: boolean;
};
export type GetDerivedUrlError = { url: null; error: 'unsupported_format' | string };

export type FolderPreviewRequest = { prefix: string };
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

export type HeadRequest = { key: string };
export type HeadResponse = {
  sizeBytes: number;
  lastModified: string; // ISO 8601
  metadata?: MetadataBag;
};

export type StorageStatsRequest = { refresh?: boolean };

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
