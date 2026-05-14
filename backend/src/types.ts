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
