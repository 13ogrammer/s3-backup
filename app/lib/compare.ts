import { api } from './api';
import type { ScanProgress, ScannedFile } from './duplicates';

export type UncomparableFile = {
  key: string;
  size: number;
  lastModified: string;
  kind: 'image' | 'video' | 'other';
  reason: 'no-etag' | 'multipart' | 'intra-folder-duplicate';
};

export type ComparePair = {
  etag: string;
  size: number;
  a: ScannedFile;
  b: ScannedFile;
};

export type FolderCompareResult = {
  prefixA: string;
  prefixB: string;
  onlyInA: ScannedFile[];
  onlyInB: ScannedFile[];
  shared: ComparePair[];
  uncomparable: {
    a: UncomparableFile[];
    b: UncomparableFile[];
  };
  totals: {
    aFetched: number;
    bFetched: number;
    aBytes: number;
    bBytes: number;
    sharedBytes: number;
    sharedBytesBothSides: number;
    uncomparableBytes: number;
  };
};

export async function scanFolder(
  prefix: string,
  signal: AbortSignal,
  onProgress?: (p: ScanProgress) => void,
): Promise<{ files: ScannedFile[]; uncomparable: UncomparableFile[]; progress: ScanProgress }> {
  const files: ScannedFile[] = [];
  const uncomparable: UncomparableFile[] = [];
  const progress: ScanProgress = {
    pagesFetched: 0,
    filesScanned: 0,
    filesWithEtag: 0,
    filesSkippedMultipart: 0,
  };

  let continuationToken: string | undefined;
  do {
    if (signal.aborted) break;
    const res = await api.list({ prefix, recursive: true, continuationToken });
    progress.pagesFetched += 1;

    for (const f of res.files) {
      if (signal.aborted) break;
      progress.filesScanned += 1;

      if (!f.etag) {
        progress.filesSkippedMultipart += 1;
        uncomparable.push({
          key: f.key,
          size: f.size,
          lastModified: f.lastModified,
          kind: f.kind,
          reason: 'no-etag',
        });
        continue;
      }

      if (f.etag.includes('-')) {
        // Multipart ETags are not content-addressable across S3 clients.
        progress.filesSkippedMultipart += 1;
        uncomparable.push({
          key: f.key,
          size: f.size,
          lastModified: f.lastModified,
          kind: f.kind,
          reason: 'multipart',
        });
        continue;
      }

      progress.filesWithEtag += 1;
      files.push({
        key: f.key,
        size: f.size,
        lastModified: f.lastModified,
        kind: f.kind,
        etag: f.etag,
        previewUrl: f.previewUrl,
      });
    }

    onProgress?.({ ...progress });
    continuationToken = res.nextToken;
  } while (continuationToken);

  return { files, uncomparable, progress };
}

export function diffFolders(
  prefixA: string,
  prefixB: string,
  a: { files: ScannedFile[]; uncomparable: UncomparableFile[] },
  b: { files: ScannedFile[]; uncomparable: UncomparableFile[] },
): FolderCompareResult {
  // Index each side by etag. When a folder contains two files with the same
  // ETag (intra-folder duplicates), only the first is kept as the
  // representative; subsequent files with that etag are routed into
  // uncomparable so that aFetched === onlyInA + shared + uncomparable.a exactly.
  const aByEtag = new Map<string, ScannedFile>();
  const aIntraDups: UncomparableFile[] = [];
  for (const f of a.files) {
    if (!aByEtag.has(f.etag)) {
      aByEtag.set(f.etag, f);
    } else {
      aIntraDups.push({ key: f.key, size: f.size, lastModified: f.lastModified, kind: f.kind, reason: 'intra-folder-duplicate' });
    }
  }

  const bByEtag = new Map<string, ScannedFile>();
  const bIntraDups: UncomparableFile[] = [];
  for (const f of b.files) {
    if (!bByEtag.has(f.etag)) {
      bByEtag.set(f.etag, f);
    } else {
      bIntraDups.push({ key: f.key, size: f.size, lastModified: f.lastModified, kind: f.kind, reason: 'intra-folder-duplicate' });
    }
  }

  const onlyInA: ScannedFile[] = [];
  const onlyInB: ScannedFile[] = [];
  const shared: ComparePair[] = [];

  for (const [etag, fileA] of aByEtag) {
    const fileB = bByEtag.get(etag);
    if (fileB) {
      shared.push({ etag, size: fileA.size, a: fileA, b: fileB });
    } else {
      onlyInA.push(fileA);
    }
  }

  for (const [etag, fileB] of bByEtag) {
    if (!aByEtag.has(etag)) {
      onlyInB.push(fileB);
    }
  }

  const uncomparableA = [...a.uncomparable, ...aIntraDups];
  const uncomparableB = [...b.uncomparable, ...bIntraDups];

  const aBytes = a.files.reduce((acc, f) => acc + f.size, 0);
  const bBytes = b.files.reduce((acc, f) => acc + f.size, 0);
  const sharedBytes = shared.reduce((acc, p) => acc + p.size, 0);
  const uncomparableBytes =
    uncomparableA.reduce((acc, f) => acc + f.size, 0) +
    uncomparableB.reduce((acc, f) => acc + f.size, 0);

  return {
    prefixA,
    prefixB,
    onlyInA,
    onlyInB,
    shared,
    uncomparable: { a: uncomparableA, b: uncomparableB },
    totals: {
      aFetched: a.files.length,
      bFetched: b.files.length,
      aBytes,
      bBytes,
      sharedBytes,
      sharedBytesBothSides: sharedBytes * 2,
      uncomparableBytes,
    },
  };
}
