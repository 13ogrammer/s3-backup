export type ListRequest = { prefix?: string; continuationToken?: string };
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

export type SignUploadRequest = { key: string; contentType: string };
export type SignUploadResponse = { url: string; expiresIn: number };

export type SignDownloadRequest = { key: string };
export type SignDownloadResponse = { url: string; expiresIn: number };

export type DeleteRequest = { keys?: string[]; prefixes?: string[] };
export type DeleteResponse = { deleted: string[]; errors: Array<{ key: string; message: string }> };

export type MoveRequest =
  | { kind: 'file'; from: string; to: string }
  | { kind: 'folder'; fromPrefix: string; toPrefix: string };
export type MoveResponse = { moved: number };

export type ExistsRequest = { keys: string[] };
export type ExistsResponse = { existing: string[] };

export type CreateMultipartRequest = { key: string; contentType: string };
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
