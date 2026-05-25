import {
  documentDirectory,
  getInfoAsync,
  readAsStringAsync,
  writeAsStringAsync,
} from 'expo-file-system/legacy';

export type BackupMode = 'all' | 'newOnly' | 'fromDate';

export type AutoBackupState = {
  enabled: boolean;
  wifiOnly: boolean;
  backupMode: BackupMode;
  customStartDate: number | null;
  prefix: string;
  lastRanAt: number | null;
  lastCreatedAt: number | null;
  failureCount: number;
  largeQueueCount: number;
};

export const DEFAULT_AUTO_BACKUP_STATE: AutoBackupState = {
  enabled: false,
  wifiOnly: true,
  backupMode: 'all',
  customStartDate: null,
  prefix: 'auto/',
  lastRanAt: null,
  lastCreatedAt: null,
  failureCount: 0,
  largeQueueCount: 0,
};

const STATE_FILE = `${documentDirectory ?? ''}auto-backup-state.json`;

// Independent mutex — do NOT share with uploadState.ts or backedUpState.ts.
// The auto-backup tick and the Settings screen may both call saveAutoBackupState
// concurrently; serialising all writes prevents interleaved read-modify-write.
let writeChain: Promise<unknown> = Promise.resolve();
function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const next = writeChain.then(fn, fn);
  writeChain = next.catch(() => undefined);
  return next as Promise<T>;
}

async function readState(): Promise<AutoBackupState> {
  try {
    const info = await getInfoAsync(STATE_FILE);
    if (!info.exists) return { ...DEFAULT_AUTO_BACKUP_STATE };
    const raw = await readAsStringAsync(STATE_FILE);
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ...DEFAULT_AUTO_BACKUP_STATE };
    }
    const obj = parsed as Record<string, unknown>;

    // Validate backupMode — anything unrecognised falls back to 'all'.
    const rawMode = obj.backupMode;
    const backupMode: BackupMode =
      rawMode === 'all' || rawMode === 'newOnly' || rawMode === 'fromDate' ? rawMode : 'all';

    return {
      enabled: typeof obj.enabled === 'boolean' ? obj.enabled : DEFAULT_AUTO_BACKUP_STATE.enabled,
      wifiOnly: typeof obj.wifiOnly === 'boolean' ? obj.wifiOnly : DEFAULT_AUTO_BACKUP_STATE.wifiOnly,
      backupMode,
      customStartDate: typeof obj.customStartDate === 'number' ? obj.customStartDate : null,
      prefix: typeof obj.prefix === 'string' ? obj.prefix : 'auto/',
      lastRanAt: typeof obj.lastRanAt === 'number' ? obj.lastRanAt : null,
      lastCreatedAt: typeof obj.lastCreatedAt === 'number' ? obj.lastCreatedAt : null,
      failureCount: typeof obj.failureCount === 'number' ? obj.failureCount : 0,
      largeQueueCount: typeof obj.largeQueueCount === 'number' ? obj.largeQueueCount : 0,
    };
  } catch (err) {
    console.warn('auto-backup-state read failed', err);
    return { ...DEFAULT_AUTO_BACKUP_STATE };
  }
}

async function writeState(state: AutoBackupState): Promise<void> {
  await writeAsStringAsync(STATE_FILE, JSON.stringify(state));
}

export function loadAutoBackupState(): Promise<AutoBackupState> {
  return serialize(readState);
}

// Accepts either a plain partial patch or a patch function that receives the
// current state. The function form is used for race-safe read-modify-write
// operations (e.g. first-tick cursor advance based on current `lastCreatedAt`)
// where the patch depends on current values.
export function saveAutoBackupState(
  patch: Partial<AutoBackupState> | ((current: AutoBackupState) => Partial<AutoBackupState>),
): Promise<AutoBackupState> {
  return serialize(async () => {
    const current = await readState();
    const partial = typeof patch === 'function' ? patch(current) : patch;
    const next: AutoBackupState = { ...current, ...partial };
    await writeState(next);
    return next;
  });
}
