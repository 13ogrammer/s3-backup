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

  if (!isAllowedApiUrl(apiUrl)) {
    return { ok: false, reason: 'bad-url' };
  }

  return { ok: true, config: { backendUrl: apiUrl, bootstrapToken } };
}

// https://anywhere, or http://<private-lan-or-loopback>. http:// to public
// hosts is rejected because the bootstrap token must not travel in clear text
// across the open internet.
function isAllowedApiUrl(apiUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(apiUrl);
  } catch {
    return false;
  }
  if (url.protocol === 'https:') return true;
  if (url.protocol === 'http:' && isPrivateHost(url.hostname)) return true;
  return false;
}

function isPrivateHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  if (h === 'localhost') return true;
  if (/^127\./.test(h)) return true;
  if (/^10\./.test(h)) return true;
  if (/^192\.168\./.test(h)) return true;
  const m = h.match(/^172\.(\d+)\./);
  if (m && Number(m[1]) >= 16 && Number(m[1]) <= 31) return true;
  return false;
}
