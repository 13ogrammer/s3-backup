import type { AppConfig } from './config';

// Exact shape of the JSON encoded in the QR code printed by `npm run qr`.
type QrPayload = { apiUrl: string; bootstrapToken: string };

export type ParseResult =
  | { ok: true; config: AppConfig }
  | { ok: false; reason: 'invalid-json' | 'missing-fields' | 'bad-url' };

/**
 * Validates the raw string decoded from a QR code scan.
 *
 * Returns ok:true with an AppConfig (apiUrl mapped to backendUrl) when the
 * payload is well-formed, or ok:false with a reason the caller can display.
 */
export function parseQrPayload(raw: string): ParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: 'invalid-json' };
  }

  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('apiUrl' in parsed) ||
    !('bootstrapToken' in parsed) ||
    typeof (parsed as QrPayload).apiUrl !== 'string' ||
    typeof (parsed as QrPayload).bootstrapToken !== 'string' ||
    !(parsed as QrPayload).apiUrl ||
    !(parsed as QrPayload).bootstrapToken
  ) {
    return { ok: false, reason: 'missing-fields' };
  }

  const { apiUrl, bootstrapToken } = parsed as QrPayload;

  if (!apiUrl.startsWith('https://')) {
    return { ok: false, reason: 'bad-url' };
  }

  return { ok: true, config: { backendUrl: apiUrl, bootstrapToken } };
}
