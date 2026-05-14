import { S3Client } from '@aws-sdk/client-s3';

export const BUCKET = process.env.BUCKET_NAME ?? '';

const endpoint = process.env.S3_ENDPOINT_URL;

export const s3 = new S3Client(
  endpoint
    ? {
        endpoint,
        forcePathStyle: true,
        region: process.env.AWS_REGION ?? 'us-east-1',
        credentials: {
          accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? 'test',
          secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? 'test',
        },
      }
    : {},
);

// Reject keys that try to escape the bucket or use absolute paths.
// S3 itself is fine with weird keys, but this guards the app's mental model
// of "folders are prefixes ending in /".
export function sanitizeKey(input: string): string {
  if (typeof input !== 'string') throw new Error('key must be a string');
  let k = input.trim();
  if (k.startsWith('/')) k = k.slice(1);
  if (k.length === 0) throw new Error('key must not be empty');
  if (k.length > 1024) throw new Error('key too long');
  if (k.includes('..')) throw new Error('key must not contain ".."');
  if (k.includes('\x00')) throw new Error('key must not contain null bytes');
  return k;
}

export function sanitizePrefix(input: string | undefined): string {
  if (input == null || input === '') return '';
  let p = input.trim();
  if (p.startsWith('/')) p = p.slice(1);
  if (p.length > 1024) throw new Error('prefix too long');
  if (p.includes('..')) throw new Error('prefix must not contain ".."');
  if (p.includes('\x00')) throw new Error('prefix must not contain null bytes');
  if (p.length > 0 && !p.endsWith('/')) p = p + '/';
  return p;
}
