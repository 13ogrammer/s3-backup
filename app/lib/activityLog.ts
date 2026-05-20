import {
  documentDirectory,
  getInfoAsync,
  readAsStringAsync,
  writeAsStringAsync,
} from 'expo-file-system/legacy';

import { ApiError } from './api';
import { UploadError } from './upload';

export type ActivityUploadEntry = {
  id: string; // `${firstAt}-${slug(remoteKey)}`
  kind: 'upload';
  remoteKey: string;
  localUri: string;
  sizeBytes: number;
  status: 'pending' | 'failed';
  reason?: string;
  failureStatus?: number;
  failureRequestId?: string;
  firstAt: number;
  lastAt: number;
  attempts: number;
};

export type ActivityMoveEntry = {
  id: string; // `${firstAt}-${slug(from)}-${slug(to)}`
  kind: 'move';
  from: string;
  to: string;
  itemKind: 'file' | 'folder';
  status: 'failed';
  reason: string;
  failureStatus?: number;
  failureRequestId?: string;
  firstAt: number;
  lastAt: number;
  attempts: number;
};

export type ActivityEntry = ActivityUploadEntry | ActivityMoveEntry;
export type ActivityFile = { schemaVersion: 1 | 2; entries: ActivityEntry[] };

const ACTIVITY_FILE = `${documentDirectory ?? ''}activity-log.json`;
const MAX_ENTRIES = 200;
const SCHEMA_VERSION = 2;

let writeChain: Promise<unknown> = Promise.resolve();
function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const next = writeChain.then(fn, fn);
  writeChain = next.catch(() => undefined);
  return next as Promise<T>;
}

function toReason(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function fromErr(err: unknown): {
  reason: string;
  failureStatus?: number;
  failureRequestId?: string;
} {
  if (err instanceof ApiError) {
    return {
      reason: err.message,
      failureStatus: err.status,
      failureRequestId: err.requestId,
    };
  }
  if (err instanceof UploadError) {
    return { reason: err.message, failureStatus: err.status };
  }
  if (err instanceof Error) {
    return { reason: err.message };
  }
  return { reason: String(err) };
}

function slug(s: string): string {
  return s.replace(/[^a-zA-Z0-9]/g, '_').slice(0, 24);
}

async function readEntries(): Promise<ActivityEntry[]> {
  try {
    const info = await getInfoAsync(ACTIVITY_FILE);
    if (!info.exists) return [];
    const raw = await readAsStringAsync(ACTIVITY_FILE);
    const parsed = JSON.parse(raw) as unknown;
    // Accept v1 and v2 — v1 entries lack failureStatus/failureRequestId (read as undefined).
    // Any other version: load empty, overwrite on next write.
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      !('entries' in parsed) ||
      !('schemaVersion' in parsed)
    ) {
      console.warn('activity-log: schema mismatch or invalid, starting fresh');
      return [];
    }
    const sv = (parsed as { schemaVersion: unknown }).schemaVersion;
    if (sv !== 1 && sv !== 2) {
      console.warn('activity-log: unknown schemaVersion', sv, '— starting fresh');
      return [];
    }
    const file = parsed as ActivityFile;
    if (!Array.isArray(file.entries)) return [];
    return file.entries;
  } catch (err) {
    console.warn('activity-log read failed', err);
    return [];
  }
}

async function writeEntries(entries: ActivityEntry[]): Promise<void> {
  const file: ActivityFile = { schemaVersion: SCHEMA_VERSION, entries };
  await writeAsStringAsync(ACTIVITY_FILE, JSON.stringify(file));
}

export function loadActivity(): Promise<ActivityEntry[]> {
  return serialize(async () => {
    const entries = await readEntries();
    return [...entries].reverse();
  });
}

export function loadActivityCount(): Promise<number> {
  return serialize(async () => {
    const entries = await readEntries();
    return entries.length;
  });
}

export function recordUploadFailure(input: {
  remoteKey: string;
  localUri: string;
  sizeBytes: number;
  reason: string;
  failureStatus?: number;
  failureRequestId?: string;
}): Promise<void> {
  return serialize(async () => {
    const entries = await readEntries();
    const existing = entries.find(
      (e): e is ActivityUploadEntry => e.kind === 'upload' && e.remoteKey === input.remoteKey,
    );
    const now = Date.now();
    if (existing) {
      existing.attempts += 1;
      existing.lastAt = now;
      existing.reason = input.reason;
      existing.status = 'failed';
      existing.failureStatus = input.failureStatus;
      existing.failureRequestId = input.failureRequestId;
    } else {
      const firstAt = now;
      const entry: ActivityUploadEntry = {
        id: `${firstAt}-${slug(input.remoteKey)}`,
        kind: 'upload',
        remoteKey: input.remoteKey,
        localUri: input.localUri,
        sizeBytes: input.sizeBytes,
        status: 'failed',
        reason: input.reason,
        failureStatus: input.failureStatus,
        failureRequestId: input.failureRequestId,
        firstAt,
        lastAt: firstAt,
        attempts: 1,
      };
      entries.push(entry);
    }
    const capped = entries.length > MAX_ENTRIES ? entries.slice(entries.length - MAX_ENTRIES) : entries;
    await writeEntries(capped);
  });
}

export function recordMoveFailure(input: {
  from: string;
  to: string;
  itemKind: 'file' | 'folder';
  reason: string;
  failureStatus?: number;
  failureRequestId?: string;
}): Promise<void> {
  return serialize(async () => {
    const entries = await readEntries();
    const existing = entries.find(
      (e): e is ActivityMoveEntry =>
        e.kind === 'move' && e.from === input.from && e.to === input.to,
    );
    const now = Date.now();
    if (existing) {
      existing.attempts += 1;
      existing.lastAt = now;
      existing.reason = input.reason;
      existing.failureStatus = input.failureStatus;
      existing.failureRequestId = input.failureRequestId;
    } else {
      const firstAt = now;
      const entry: ActivityMoveEntry = {
        id: `${firstAt}-${slug(input.from)}-${slug(input.to)}`,
        kind: 'move',
        from: input.from,
        to: input.to,
        itemKind: input.itemKind,
        status: 'failed',
        reason: input.reason,
        failureStatus: input.failureStatus,
        failureRequestId: input.failureRequestId,
        firstAt,
        lastAt: firstAt,
        attempts: 1,
      };
      entries.push(entry);
    }
    const capped = entries.length > MAX_ENTRIES ? entries.slice(entries.length - MAX_ENTRIES) : entries;
    await writeEntries(capped);
  });
}

export function removeActivityEntry(id: string): Promise<void> {
  return serialize(async () => {
    const entries = await readEntries();
    const next = entries.filter((e) => e.id !== id);
    if (next.length === entries.length) return;
    await writeEntries(next);
  });
}

export function removeUploadEntryByKey(remoteKey: string): Promise<void> {
  return serialize(async () => {
    const entries = await readEntries();
    const next = entries.filter(
      (e) => !(e.kind === 'upload' && e.remoteKey === remoteKey),
    );
    if (next.length === entries.length) return;
    await writeEntries(next);
  });
}

export function clearActivity(): Promise<void> {
  return serialize(async () => {
    await writeEntries([]);
  });
}

// Re-export toReason so call sites in index.tsx / browse.tsx can format errors
// consistently without importing a separate utility.
export { toReason };
