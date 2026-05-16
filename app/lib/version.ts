import Constants from 'expo-constants';

export const VERSION_MANIFEST_URL = '';

export type VersionManifest = {
  latestNativeVersion: string;
  minSupportedVersion: string;
  apkUrl: string;
  releaseNotes: string;
};

export async function fetchVersionManifest(): Promise<VersionManifest | null> {
  if (!VERSION_MANIFEST_URL) return null;
  try {
    const res = await fetch(VERSION_MANIFEST_URL, { cache: 'no-store' });
    if (!res.ok) return null;
    const data = await res.json();
    if (
      typeof data?.latestNativeVersion !== 'string' ||
      typeof data?.minSupportedVersion !== 'string' ||
      typeof data?.apkUrl !== 'string' ||
      typeof data?.releaseNotes !== 'string'
    ) {
      return null;
    }
    return data as VersionManifest;
  } catch {
    return null;
  }
}

export function semverLt(a: string, b: string): boolean {
  const pa = a.split('.').map((s) => parseInt(s, 10) || 0);
  const pb = b.split('.').map((s) => parseInt(s, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const av = pa[i] ?? 0;
    const bv = pb[i] ?? 0;
    if (av < bv) return true;
    if (av > bv) return false;
  }
  return false;
}

export function getAppVersion(): string {
  return Constants.expoConfig?.version ?? '0.0.0';
}
