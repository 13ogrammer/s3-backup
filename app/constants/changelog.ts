export type ChangelogEntry = {
  version: string;
  date: string;
  notes: readonly string[];
};

export const CHANGELOG_ENTRIES: readonly ChangelogEntry[] = [
  {
    version: '1.1.0',
    date: '2026-05-17',
    notes: [
      'In-app update banner and blocking modal when a new native version is available',
      'OTA JS delivery via Expo Updates',
      'Date-range filter for the Gallery tab',
      'Shimmer skeleton loading for Browse thumbnails',
      'Preview image served from .previews/ tier with original fallback',
      'Skip-if-exists upload deduplication',
      'Parallel uploads with retry on transient failure',
    ],
  },
  {
    version: '1.0.0',
    date: '2026-05-15',
    notes: [
      'Gallery tab: pick photos and videos from your device and upload to a chosen S3 folder',
      'Browse tab: thumbnails, sort, grid/list toggle, infinite scroll, pinch-zoom preview',
      'Preview: horizontal swipe between files, move, rename, delete',
      'Settings tab: configure backend URL and bootstrap token',
      'AWS Lambda + API Gateway backend deployable via SAM',
      'MinIO-based local development loop',
      'Thumbnail backfill script for pre-existing buckets',
    ],
  },
] as const;
