import {
  documentDirectory,
  getInfoAsync,
  readAsStringAsync,
  writeAsStringAsync,
} from 'expo-file-system/legacy';

import { ApiError } from './api';
import type { MergePolicy } from './api';
import { UploadError } from './upload';

export type ActivityUploadEntry = {
  id: string; // `${firstAt}-${slug(remoteKey)}`
  kind: 'upload';
  remoteKey: string;
  localUri?: string;            // present on pending/failed; absent on success
  sizeBytes: number;
  status: 'pending' | 'failed' | 'success';
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
  status: 'failed' | 'success';
  reason?: string;
  failureStatus?: number;
  failureRequestId?: string;
  firstAt: number;
  lastAt: number;
  attempts: number;
  mergePolicy?: MergePolicy;
  mergeCounts?: { moved: number; renamed: number; skipped: number; failed: number };
};

export type ActivityAutoBackupRunEntry = {
  id: string;                   // `${startedAt}-autorun`
  kind: 'autoBackupRun';
  status: 'success' | 'failed';
  startedAt: number;
  completedAt: number;
  firstAt: number;              // = startedAt
  lastAt: number;               // = completedAt
  uploadedCount: number;
  failedCount: number;
  skippedCount: number;
  reason?: string;
};

export type ActivityEntry =
  | ActivityUploadEntry
  | ActivityMoveEntry
  | ActivityAutoBackupRunEntry;

export type ActivityFile = { schemaVersion: 1 | 2 | 3 | 4; entries: ActivityEntry[] };

const ACTIVITY_FILE = `${documentDirectory ?? ''}activity-log.json`;
const MAX_ENTRIES = 200;
const SCHEMA_VERSION = 4;
// 30-day retention policy: entries older than this are pruned on read.
// Bounded retention prevents the log from growing unboundedly on devices
// that accumulate entries over months without clearing them.
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

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
    // Accept v1, v2, and v3. Any other version: load empty, overwrite on next write.
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
    if (sv !== 1 && sv !== 2 && sv !== 3 && sv !== 4) {
      console.warn('activity-log: unknown schemaVersion', sv, '— starting fresh');
      return [];
    }
    const file = parsed as { schemaVersion: number; entries: unknown[] };
    if (!Array.isArray(file.entries)) return [];
    // Backfill: v1/v2 upload and move entries lacked `status`; treat as 'failed'.
    return file.entries.map((e) => {
      const entry = e as Record<string, unknown>;
      if (entry.kind === 'upload' && entry.status == null) {
        return { ...entry, status: 'failed' } as ActivityEntry;
      }
      if (entry.kind === 'move' && entry.status == null) {
        return { ...entry, status: 'failed' } as ActivityEntry;
      }
      return e as ActivityEntry;
    });
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
    const cutoff = Date.now() - RETENTION_MS;
    const kept = entries.filter((e) => e.lastAt >= cutoff);
    if (kept.length !== entries.length) await writeEntries(kept);
    return [...kept].reverse();
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
      existing.localUri = input.localUri;
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

export function recordUploadSuccess(input: {
  remoteKey: string;
  sizeBytes: number;
}): Promise<void> {
  return serialize(async () => {
    const entries = await readEntries();
    const existing = entries.find(
      (e): e is ActivityUploadEntry => e.kind === 'upload' && e.remoteKey === input.remoteKey,
    );
    const now = Date.now();
    if (existing) {
      // Promote the existing row (which may have been failed/pending) to success.
      // Drop device-path and failure details — they no longer apply.
      existing.attempts += 1;
      existing.lastAt = now;
      existing.status = 'success';
      delete existing.localUri;
      delete existing.reason;
      delete existing.failureStatus;
      delete existing.failureRequestId;
    } else {
      const firstAt = now;
      const entry: ActivityUploadEntry = {
        id: `${firstAt}-${slug(input.remoteKey)}`,
        kind: 'upload',
        remoteKey: input.remoteKey,
        sizeBytes: input.sizeBytes,
        status: 'success',
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
      existing.status = 'failed';
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

export function recordMoveSuccess(input: {
  from: string;
  to: string;
  itemKind: 'file' | 'folder';
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
      existing.status = 'success';
      delete existing.reason;
      delete existing.failureStatus;
      delete existing.failureRequestId;
    } else {
      const firstAt = now;
      const entry: ActivityMoveEntry = {
        id: `${firstAt}-${slug(input.from)}-${slug(input.to)}`,
        kind: 'move',
        from: input.from,
        to: input.to,
        itemKind: input.itemKind,
        status: 'success',
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

export function recordAutoBackupRun(input: {
  startedAt: number;
  completedAt: number;
  uploadedCount: number;
  failedCount: number;
  skippedCount: number;
  status: 'success' | 'failed';
  reason?: string;
}): Promise<void> {
  return serialize(async () => {
    const entries = await readEntries();
    const entry: ActivityAutoBackupRunEntry = {
      id: `${input.startedAt}-autorun`,
      kind: 'autoBackupRun',
      status: input.status,
      startedAt: input.startedAt,
      completedAt: input.completedAt,
      firstAt: input.startedAt,
      lastAt: input.completedAt,
      uploadedCount: input.uploadedCount,
      failedCount: input.failedCount,
      skippedCount: input.skippedCount,
      reason: input.reason,
    };
    entries.push(entry);
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

export function recordMergeFolderSuccess(input: {
  from: string;
  to: string;
  policy: MergePolicy;
  counts?: { moved: number; renamed: number; skipped: number; failed: number };
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
      existing.status = 'success';
      existing.mergePolicy = input.policy;
      if (input.counts) existing.mergeCounts = input.counts;
      delete existing.reason;
      delete existing.failureStatus;
      delete existing.failureRequestId;
    } else {
      const firstAt = now;
      const entry: ActivityMoveEntry = {
        id: `${firstAt}-${slug(input.from)}-${slug(input.to)}`,
        kind: 'move',
        from: input.from,
        to: input.to,
        itemKind: 'folder',
        status: 'success',
        mergePolicy: input.policy,
        ...(input.counts ? { mergeCounts: input.counts } : {}),
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

export function recordMergeFolderFailure(input: {
  from: string;
  to: string;
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
      existing.status = 'failed';
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
        itemKind: 'folder',
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

// Re-export toReason so call sites in index.tsx / browse.tsx can format errors
// consistently without importing a separate utility.
export { toReason };
