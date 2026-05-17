import {
  documentDirectory,
  getInfoAsync,
  readAsStringAsync,
  writeAsStringAsync,
} from 'expo-file-system/legacy';

export type AuditEntry = {
  id: string;
  at: string;
  action: 'delete-duplicates';
  strategy: 'newest' | 'oldest' | 'manual';
  keptKey: string;
  discardedKeys: string[];
  recoveredBytes: number;
};

const AUDIT_FILE = `${documentDirectory ?? ''}duplicates-audit-log.json`;
const MAX_ENTRIES = 100;

let writeChain: Promise<unknown> = Promise.resolve();
function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const next = writeChain.then(fn, fn);
  writeChain = next.catch(() => undefined);
  return next as Promise<T>;
}

async function readEntries(): Promise<AuditEntry[]> {
  try {
    const info = await getInfoAsync(AUDIT_FILE);
    if (!info.exists) return [];
    const raw = await readAsStringAsync(AUDIT_FILE);
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed as AuditEntry[];
  } catch (err) {
    console.warn('audit-log read failed', err);
    return [];
  }
}

async function writeEntries(entries: AuditEntry[]): Promise<void> {
  await writeAsStringAsync(AUDIT_FILE, JSON.stringify(entries));
}

export function loadAudit(): Promise<AuditEntry[]> {
  return serialize(async () => {
    const entries = await readEntries();
    // Return newest first.
    return [...entries].reverse();
  });
}

export function appendAudit(entry: Omit<AuditEntry, 'id' | 'at'>): Promise<void> {
  return serialize(async () => {
    const entries = await readEntries();
    const full: AuditEntry = {
      ...entry,
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      at: new Date().toISOString(),
    };
    entries.push(full);
    // FIFO cap: keep the most recent MAX_ENTRIES.
    const capped = entries.length > MAX_ENTRIES ? entries.slice(entries.length - MAX_ENTRIES) : entries;
    await writeEntries(capped);
  });
}

export function clearAudit(): Promise<void> {
  return serialize(async () => {
    await writeEntries([]);
  });
}
