import {
  documentDirectory,
  getInfoAsync,
  readAsStringAsync,
  writeAsStringAsync,
} from 'expo-file-system/legacy';

import type { CompletedPart } from './api';

// Records the state of an in-flight upload so it can survive an app
// suspend/kill and be resumed on next foreground. Not stored in SecureStore
// because the per-part ETag list grows past the iOS Keychain per-item budget
// for large videos (1000+ parts × ~40 bytes JSON each). Tokens still live in
// SecureStore — this file holds non-sensitive state.

type PendingUploadBase = {
  localUri: string;
  remoteKey: string;
  contentType: string;
  totalBytes: number;
  updatedAt: number;
};

export type PendingMultipartUpload = PendingUploadBase & {
  kind: 'multipart';
  uploadId: string;
  partSize: number;
  completedParts: CompletedPart[];
};

export type PendingSimpleUpload = PendingUploadBase & {
  kind: 'simple';
  // Server-authoritative Unix ms timestamp from signedAt in SignUploadResponse.
  // Used to detect a stale URL before retrying (re-sign if > 23 h old).
  // Defaults to 0 for entries written before this field was introduced.
  signedAt: number;
};

export type PendingUpload = PendingMultipartUpload | PendingSimpleUpload;

const STATE_FILE = `${documentDirectory ?? ''}upload-state.json`;

// Single-writer mutex so parallel part-upload workers don't clobber
// each other in the read-modify-write cycle.
let writeChain: Promise<unknown> = Promise.resolve();
function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const next = writeChain.then(fn, fn);
  writeChain = next.catch(() => undefined);
  return next as Promise<T>;
}

async function readAll(): Promise<PendingUpload[]> {
  try {
    const info = await getInfoAsync(STATE_FILE);
    if (!info.exists) return [];
    const raw = await readAsStringAsync(STATE_FILE);
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isValidPending).map(normalizeEntry);
  } catch (err) {
    console.warn('upload-state read failed', err);
    return [];
  }
}

// Entries written before the kind discriminator was introduced have all
// multipart fields but no `kind` property. Normalise them here so every
// caller receives a fully-typed PendingUpload.
// S3B-6: simple entries written before signedAt was added get signedAt=0,
// which forces a re-sign on the first resume (0 is always > 23 h stale).
function normalizeEntry(x: PendingUpload | LegacyMultipartEntry): PendingUpload {
  if (!('kind' in x) || x.kind === undefined) {
    return { ...(x as LegacyMultipartEntry), kind: 'multipart' };
  }
  if (x.kind === 'simple' && (x as PendingSimpleUpload).signedAt === undefined) {
    return { ...(x as PendingSimpleUpload), signedAt: 0 };
  }
  return x as PendingUpload;
}

async function writeAll(items: PendingUpload[]): Promise<void> {
  await writeAsStringAsync(STATE_FILE, JSON.stringify(items));
}

// A legacy entry looks like a multipart entry but has no `kind` field.
type LegacyMultipartEntry = Omit<PendingMultipartUpload, 'kind'>;

export function isValidPending(x: unknown): x is PendingUpload | LegacyMultipartEntry {
  if (!x || typeof x !== 'object') return false;
  const o = x as Record<string, unknown>;

  // Base fields required by all kinds.
  if (
    typeof o.localUri !== 'string' ||
    typeof o.remoteKey !== 'string' ||
    typeof o.contentType !== 'string' ||
    typeof o.totalBytes !== 'number'
  ) {
    return false;
  }

  const kind = o.kind;

  // Simple upload: base fields + kind discriminator. signedAt is optional
  // here so legacy entries written before S3B-6 still pass validation;
  // normalizeEntry fills in 0.
  if (kind === 'simple') {
    return o.signedAt === undefined || typeof o.signedAt === 'number';
  }

  // Multipart (explicit or legacy untagged): needs uploadId, partSize, completedParts.
  if (kind === 'multipart' || kind === undefined) {
    return (
      typeof o.uploadId === 'string' &&
      typeof o.partSize === 'number' &&
      Array.isArray(o.completedParts)
    );
  }

  return false;
}

export function loadPendingUploads(): Promise<PendingUpload[]> {
  return serialize(readAll);
}

export function savePendingUpload(entry: PendingUpload): Promise<void> {
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
