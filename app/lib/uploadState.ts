import {
  documentDirectory,
  getInfoAsync,
  readAsStringAsync,
  writeAsStringAsync,
} from 'expo-file-system/legacy';

import type { CompletedPart } from './api';

// Records the state of an in-flight multipart upload so it can survive
// an app suspend/kill and be resumed on next foreground. Not stored in
// SecureStore because the per-part ETag list grows past the iOS Keychain
// per-item budget for large videos (1000+ parts × ~40 bytes JSON each).
// Tokens still live in SecureStore — this file holds non-sensitive state.
export type PendingMultipartUpload = {
  localUri: string;
  remoteKey: string;
  contentType: string;
  uploadId: string;
  totalBytes: number;
  partSize: number;
  completedParts: CompletedPart[];
  updatedAt: number;
};

const STATE_FILE = `${documentDirectory ?? ''}upload-state.json`;

// Single-writer mutex so parallel part-upload workers don't clobber
// each other in the read-modify-write cycle.
let writeChain: Promise<unknown> = Promise.resolve();
function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const next = writeChain.then(fn, fn);
  writeChain = next.catch(() => undefined);
  return next as Promise<T>;
}

async function readAll(): Promise<PendingMultipartUpload[]> {
  try {
    const info = await getInfoAsync(STATE_FILE);
    if (!info.exists) return [];
    const raw = await readAsStringAsync(STATE_FILE);
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isValidPending);
  } catch (err) {
    console.warn('upload-state read failed', err);
    return [];
  }
}

async function writeAll(items: PendingMultipartUpload[]): Promise<void> {
  await writeAsStringAsync(STATE_FILE, JSON.stringify(items));
}

function isValidPending(x: unknown): x is PendingMultipartUpload {
  if (!x || typeof x !== 'object') return false;
  const o = x as Record<string, unknown>;
  return (
    typeof o.localUri === 'string' &&
    typeof o.remoteKey === 'string' &&
    typeof o.contentType === 'string' &&
    typeof o.uploadId === 'string' &&
    typeof o.totalBytes === 'number' &&
    typeof o.partSize === 'number' &&
    Array.isArray(o.completedParts)
  );
}

export function loadPendingUploads(): Promise<PendingMultipartUpload[]> {
  return serialize(readAll);
}

export function savePendingUpload(entry: PendingMultipartUpload): Promise<void> {
  return serialize(async () => {
    const items = await readAll();
    const next = items.filter((e) => e.remoteKey !== entry.remoteKey);
    next.push({ ...entry, updatedAt: Date.now() });
    await writeAll(next);
  });
}

export function removePendingUpload(remoteKey: string): Promise<void> {
  return serialize(async () => {
    const items = await readAll();
    const next = items.filter((e) => e.remoteKey !== remoteKey);
    if (next.length === items.length) return;
    await writeAll(next);
  });
}

export function clearAllPendingUploads(): Promise<void> {
  return serialize(async () => {
    await writeAll([]);
  });
}
