import { GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { ensureDerived, NotAnImageError, UnsupportedFormatError } from '../derive.js';
import { BUCKET, s3, sanitizeKey } from '../s3.js';
import type {
  DerivedTier,
  GetDerivedUrlRequest,
  GetDerivedUrlResponse,
  GetDerivedUrlError,
} from '../types.js';

const EXPIRES_IN = 600;

const VALID_TIERS = new Set<DerivedTier>(['thumbnail', 'preview']);

export async function getDerivedUrl(
  body: GetDerivedUrlRequest,
): Promise<GetDerivedUrlResponse | GetDerivedUrlError> {
  const key = sanitizeKey(body.key);

  const tier: DerivedTier = body.tier;
  if (!VALID_TIERS.has(tier)) {
    throw new Error(`tier must be 'thumbnail' or 'preview'; got: ${String(tier)}`);
  }

  let result: { derivedKey: string; generated: boolean };
  try {
    result = await ensureDerived(key, tier);
  } catch (err) {
    if (err instanceof UnsupportedFormatError || err instanceof NotAnImageError) {
      return { url: null, error: 'unsupported_format' };
    }
    throw err;
  }

  const url = await getSignedUrl(
    s3,
    new GetObjectCommand({ Bucket: BUCKET, Key: result.derivedKey }),
    { expiresIn: EXPIRES_IN },
  );

  return { url, expiresIn: EXPIRES_IN, tier, generated: result.generated };
}
