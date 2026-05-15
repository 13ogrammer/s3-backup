import type * as MediaLibrary from 'expo-media-library';

export type GalleryRow = (MediaLibrary.Asset | null)[];

export type GallerySection = {
  bucketKey: string;
  title: string;
  assetIds: string[];
  data: GalleryRow[];
};

export function bucketKeyForAsset(asset: MediaLibrary.Asset): string {
  if (!asset.creationTime || asset.creationTime === 0) return 'unknown';
  return new Date(asset.creationTime).toDateString();
}

export function formatSectionLabel(bucketKey: string, now: Date): string {
  if (bucketKey === 'unknown') return 'Unknown date';

  const date = new Date(bucketKey);

  // Normalise both dates to local midnight for whole-day comparison.
  const todayMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const dateMidnight = new Date(date.getFullYear(), date.getMonth(), date.getDate());

  const diffMs = todayMidnight.getTime() - dateMidnight.getTime();
  const diffDays = Math.round(diffMs / (1000 * 60 * 60 * 24));

  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Yesterday';
  if (diffDays >= 2 && diffDays <= 6) {
    return date.toLocaleDateString(undefined, { weekday: 'long' });
  }
  return date.toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' });
}

function chunkIntoRows(assets: MediaLibrary.Asset[]): GalleryRow[] {
  const rows: GalleryRow[] = [];
  for (let i = 0; i < assets.length; i += 3) {
    const row: GalleryRow = [
      assets[i] ?? null,
      assets[i + 1] ?? null,
      assets[i + 2] ?? null,
    ];
    rows.push(row);
  }
  return rows;
}

export function buildGallerySections(
  assets: readonly MediaLibrary.Asset[],
  now: Date,
): GallerySection[] {
  const buckets = new Map<string, MediaLibrary.Asset[]>();

  for (const asset of assets) {
    const key = bucketKeyForAsset(asset);
    const existing = buckets.get(key);
    if (existing) {
      existing.push(asset);
    } else {
      buckets.set(key, [asset]);
    }
  }

  const sections: GallerySection[] = [];

  for (const [bucketKey, bucketAssets] of buckets.entries()) {
    if (bucketKey === 'unknown') continue;
    sections.push({
      bucketKey,
      title: formatSectionLabel(bucketKey, now),
      assetIds: bucketAssets.map((a) => a.id),
      data: chunkIntoRows(bucketAssets),
    });
  }

  // "Unknown date" always goes last.
  const unknownAssets = buckets.get('unknown');
  if (unknownAssets && unknownAssets.length > 0) {
    sections.push({
      bucketKey: 'unknown',
      title: 'Unknown date',
      assetIds: unknownAssets.map((a) => a.id),
      data: chunkIntoRows(unknownAssets),
    });
  }

  return sections;
}
