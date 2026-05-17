import { GetObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { classifyKey } from '../mediaType.js';
import { BUCKET, s3, sanitizePrefix } from '../s3.js';
import { thumbKey, thumbPrefix } from '../thumbs.js';
import type { FolderPreviewRequest, FolderPreviewResponse, FolderPreviewThumb } from '../types.js';
import type { RequestContext } from '../index.js';

const PREVIEW_TTL = 60 * 10;
const MAX_THUMBS = 3;
const SCAN_MAX_KEYS = 100;

async function listThumbKeys(prefix: string): Promise<Set<string>> {
  const found = new Set<string>();
  let continuationToken: string | undefined;
  do {
    const res = await s3.send(
      new ListObjectsV2Command({
        Bucket: BUCKET,
        Prefix: thumbPrefix(prefix),
        Delimiter: '/',
        ContinuationToken: continuationToken,
      }),
    );
    for (const obj of res.Contents ?? []) {
      if (obj.Key) found.add(obj.Key);
    }
    continuationToken = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (continuationToken);
  return found;
}

type MediaCandidate = { key: string; lastModified: Date; kind: 'image' | 'video' };

async function scanPrefix(prefix: string): Promise<{
  candidates: MediaCandidate[];
  hasContent: boolean;
  subPrefixes: string[];
}> {
  const res = await s3.send(
    new ListObjectsV2Command({
      Bucket: BUCKET,
      Prefix: prefix,
      Delimiter: '/',
      MaxKeys: SCAN_MAX_KEYS,
    }),
  );

  const hasContent =
    (res.Contents ?? []).length > 0 || (res.CommonPrefixes ?? []).length > 0;

  const subPrefixes = (res.CommonPrefixes ?? [])
    .map((cp) => cp.Prefix)
    .filter((p): p is string => !!p)
    .sort();

  const candidates: MediaCandidate[] = [];
  for (const obj of res.Contents ?? []) {
    if (!obj.Key || obj.Key === prefix) continue;
    const kind = classifyKey(obj.Key);
    if (kind === 'image' || kind === 'video') {
      candidates.push({
        key: obj.Key,
        lastModified: obj.LastModified ?? new Date(0),
        kind,
      });
    }
  }

  // Sort by LastModified desc so we pick the most recent items first.
  candidates.sort((a, b) => b.lastModified.getTime() - a.lastModified.getTime());

  return { candidates, hasContent, subPrefixes };
}

export async function folderPreview(body: FolderPreviewRequest, ctx: RequestContext): Promise<FolderPreviewResponse> {
  if (!body.prefix) throw new Error('prefix is required');
  const prefix = sanitizePrefix(body.prefix);
  if (!prefix) throw new Error('prefix is required');

  const { candidates, hasContent, subPrefixes } = await scanPrefix(prefix);

  let effectiveCandidates = candidates;
  // The effective prefix for sidecar lookup — same as prefix unless we recurse.
  let effectivePrefix = prefix;

  // One-level recursion: if no media at this level but sub-prefixes exist,
  // try the first alphabetical sub-prefix (depth cap: 1).
  if (effectiveCandidates.length === 0 && subPrefixes.length > 0) {
    const subResult = await scanPrefix(subPrefixes[0]!);
    effectiveCandidates = subResult.candidates;
    effectivePrefix = subPrefixes[0]!;
  }

  if (effectiveCandidates.length === 0) {
    return { prefix, thumbs: [], hasContent };
  }

  const top = effectiveCandidates.slice(0, MAX_THUMBS);

  // List thumbnail sidecars for the prefix that actually holds the media.
  const thumbKeys = await listThumbKeys(effectivePrefix);

  const thumbs: FolderPreviewThumb[] = await Promise.all(
    top
      .filter((c) => thumbKeys.has(thumbKey(c.key)))
      .map(async (c): Promise<FolderPreviewThumb> => {
        const tk = thumbKey(c.key);
        const url = await getSignedUrl(
          s3,
          new GetObjectCommand({ Bucket: BUCKET, Key: tk }),
          { expiresIn: PREVIEW_TTL },
        );
        return { key: c.key, url, kind: c.kind };
      }),
  );

  ctx.log.info('folder-preview', { prefix, thumbCount: thumbs.length, hasContent });
  return { prefix, thumbs, hasContent };
}
