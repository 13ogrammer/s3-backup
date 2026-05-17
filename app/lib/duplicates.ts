export type ScannedFile = {
  key: string;
  size: number;
  lastModified: string;
  kind: 'image' | 'video' | 'other';
  etag: string;
  previewUrl?: string;
};

export type DuplicateGroup = {
  id: string;
  etag: string;
  size: number;
  files: ScannedFile[];
  recoverableBytes: number;
};

export type ScanProgress = {
  pagesFetched: number;
  filesScanned: number;
  filesWithEtag: number;
  filesSkippedMultipart: number;
};

export function groupByEtag(files: ScannedFile[]): DuplicateGroup[] {
  const byEtag = new Map<string, ScannedFile[]>();
  for (const f of files) {
    const bucket = byEtag.get(f.etag) ?? [];
    bucket.push(f);
    byEtag.set(f.etag, bucket);
  }

  const groups: DuplicateGroup[] = [];
  for (const [etag, members] of byEtag) {
    if (members.length < 2) continue;
    // All files in a group share the same content so size is identical.
    const size = members[0]!.size;
    // Keep one copy; the rest are recoverable.
    const recoverableBytes = size * (members.length - 1);
    groups.push({ id: etag, etag, size, files: members, recoverableBytes });
  }

  // Sort by recoverable bytes descending so highest-impact groups surface first.
  groups.sort((a, b) => b.recoverableBytes - a.recoverableBytes);
  return groups;
}

export type KeepStrategy = 'newest' | 'oldest';

export function pickKeepers(
  group: DuplicateGroup,
  strategy: KeepStrategy,
): { keep: ScannedFile; discard: ScannedFile[] } {
  const sorted = [...group.files].sort((a, b) =>
    a.lastModified.localeCompare(b.lastModified),
  );
  const keep = strategy === 'newest' ? sorted[sorted.length - 1]! : sorted[0]!;
  const discard = group.files.filter((f) => f.key !== keep.key);
  return { keep, discard };
}
