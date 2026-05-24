// Client-side prefix validation for the configurable upload prefix.
// Mirrors the sanitizePrefix logic in backend/src/s3.ts but with inline
// error messages for the UI. No import from backend/ — kept entirely in app/.

export const PREFIX_MAX_LENGTH = 200;

export type PrefixValidationResult =
  | { ok: true; value: string }
  | { ok: false; error: string };

/**
 * Validates and sanitises a prefix string entered by the user.
 *
 * Rules (applied in order):
 *  1. Trim whitespace.
 *  2. Strip leading "/".
 *  3. Empty string is valid (means bucket root).
 *  4. Reject if it contains "..".
 *  5. Reject if it contains null bytes.
 *  6. Reject if length > PREFIX_MAX_LENGTH.
 *  7. Append trailing "/" if non-empty and missing.
 */
export function validatePrefix(input: string): PrefixValidationResult {
  let p = input.trim();
  if (p.startsWith('/')) p = p.slice(1);

  if (p.includes('..')) {
    return { ok: false, error: 'Prefix must not contain "..".' };
  }
  if (p.includes('\x00')) {
    return { ok: false, error: 'Prefix must not contain null bytes.' };
  }
  if (p.length > PREFIX_MAX_LENGTH) {
    return { ok: false, error: `Prefix must be ${PREFIX_MAX_LENGTH} characters or fewer.` };
  }

  if (p.length > 0 && !p.endsWith('/')) p = p + '/';

  return { ok: true, value: p };
}

/**
 * Returns the sanitised prefix, or throws if the input is invalid.
 * Suitable for use at save time where errors have already been shown inline.
 */
export function sanitizePrefix(input: string): string {
  const result = validatePrefix(input);
  if (!result.ok) throw new Error(result.error);
  return result.value;
}
