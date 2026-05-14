import { timingSafeEqual } from 'node:crypto';

const expected = process.env.BOOTSTRAP_TOKEN ?? '';

export function isAuthorized(headerValue: string | undefined): boolean {
  if (!expected) return false;
  if (!headerValue) return false;

  const match = /^Bearer\s+(.+)$/.exec(headerValue.trim());
  if (!match) return false;
  const presented = match[1]!;

  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
