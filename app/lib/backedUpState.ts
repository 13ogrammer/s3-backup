import {
  documentDirectory,
  getInfoAsync,
  readAsStringAsync,
  writeAsStringAsync,
} from 'expo-file-system/legacy';

// Persists the local assetId → remoteKey map so backed-up tiles can be
// visually differentiated in the gallery grid without an API round-trip.
// Complements uploadState.ts (which tracks in-flight multipart uploads);
// this file records completed ones.
export type BackedUpMap = Record<string, string>;

const MAP_FILE = `${documentDirectory ?? ''}backed-up-map.json`;

// Single-writer mutex — same pattern as uploadState.ts — so concurrent
// upload workers don't clobber each other's read-modify-write cycle.
let writeChain: Promise<unknown> = Promise.resolve();
function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const next = writeChain.then(fn, fn);
  writeChain = next.catch(() => undefined);
  return next as Promise<T>;
}

async function readMap(): Promise<BackedUpMap> {
  try {
    const info = await getInfoAsync(MAP_FILE);
    if (!info.exists) return {};
    const raw = await readAsStringAsync(MAP_FILE);
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    // Filter out any entries whose key or value is not a string (defensive
    // against corruption from future schema changes).
    const obj = parsed as Record<string, unknown>;
    const clean: BackedUpMap = {};
    for (const [k, v] of Object.entries(obj)) {
      if (typeof k === 'string' && typeof v === 'string') {
        clean[k] = v;
      }
    }
    return clean;
  } catch (err) {
    console.warn('backed-up-map read failed', err);
    return {};
  }
}

async function writeMap(map: BackedUpMap): Promise<void> {
  await writeAsStringAsync(MAP_FILE, JSON.stringify(map));
}

export function loadBackedUpMap(): Promise<BackedUpMap> {
  return serialize(readMap);
}

export function recordBackedUp(assetId: string, remoteKey: string): Promise<void> {
  return serialize(async () => {
    const map = await readMap();
    map[assetId] = remoteKey; // latest-wins
    await writeMap(map);
  });
}

export function clearBackedUpMap(): Promise<void> {
  return serialize(async () => {
    await writeMap({});
  });
}
