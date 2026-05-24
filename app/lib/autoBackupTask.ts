import * as BackgroundTask from 'expo-background-task';
import * as MediaLibrary from 'expo-media-library';
import * as TaskManager from 'expo-task-manager';
import NetInfo from '@react-native-community/netinfo';

import { loadBackedUpMap, recordBackedUp } from './backedUpState';
import { loadConfig } from './config';
import { loadAutoBackupState, saveAutoBackupState } from './autoBackupState';
import { captureException } from './sentry';
import { uploadFileBackground } from './upload';

export const AUTO_BACKUP_TASK = 'AUTO_BACKUP_TASK';

// Maximum assets fetched per background tick. Keeps each tick short
// enough for the OS background-task time budget.
const AUTO_BACKUP_BATCH = 50;

// Files at or above this size are skipped in background context and queued
// for foreground upload. Matches the constant in upload.ts.
const BACKGROUND_MAX_BYTES = 5 * 1024 * 1024 * 1024; // 5 GB

// defineTask MUST be called at module top level (not inside a function) so
// TaskManager can find it synchronously when the OS wakes the task.
// _layout.tsx imports this module as a side effect to ensure it runs before
// any task registration.
TaskManager.defineTask(AUTO_BACKUP_TASK, async () => {
  try {
    await runAutoBackupTick();
    return BackgroundTask.BackgroundTaskResult.Success;
  } catch (err) {
    captureException(err, { tags: { area: 'autoBackup', stage: 'tick' } });
    return BackgroundTask.BackgroundTaskResult.Failed;
  }
});

// Register the periodic background task. Idempotent — safe to call if the
// task is already registered (e.g. on app restart when enabled was true).
export async function registerAutoBackup(): Promise<void> {
  const isRegistered = await TaskManager.isTaskRegisteredAsync(AUTO_BACKUP_TASK);
  if (!isRegistered) {
    await BackgroundTask.registerTaskAsync(AUTO_BACKUP_TASK, { minimumInterval: 15 });
  }
}

// Unregister the periodic background task. Idempotent — safe to call if the
// task is not registered.
export async function unregisterAutoBackup(): Promise<void> {
  const isRegistered = await TaskManager.isTaskRegisteredAsync(AUTO_BACKUP_TASK);
  if (isRegistered) {
    await BackgroundTask.unregisterTaskAsync(AUTO_BACKUP_TASK);
  }
}

type TickResult = { uploaded: number; skippedLarge: number; failed: number };

// Core auto-backup logic. Can be called from:
//   • The registered background task body (above).
//   • Settings toggle ON → setImmediate(() => runAutoBackupTick()) for first scan.
//
// Fail-closed: early-exit on paused, missing config, no Wi-Fi, or denied
// permission without advancing lastCreatedAt so the next tick retries.
export async function runAutoBackupTick(): Promise<TickResult> {
  const empty: TickResult = { uploaded: 0, skippedLarge: 0, failed: 0 };

  const state = await loadAutoBackupState();
  if (!state.enabled || state.paused) return empty;

  const config = await loadConfig();
  // Missing config → don't bump failureCount; backend isn't set up yet.
  if (!config) return empty;

  if (state.wifiOnly) {
    const net = await NetInfo.fetch();
    // Exit without updating cursor or lastRanAt so the next tick retries
    // once Wi-Fi is available.
    if (net.type !== 'wifi') return empty;
  }

  // Prefer getPermissionsAsync to avoid prompting from background context.
  const { status } = await MediaLibrary.getPermissionsAsync();
  if (status !== 'granted') {
    // `undetermined` = user hasn't been asked yet. Silent no-op: the Settings
    // toggle prompts before enabling, so foreground UI will resolve it.
    // `denied` = user revoked (or OS reset) — worth a Sentry breadcrumb and a
    // failureCount bump so the Gallery chip surfaces it.
    if (status === 'denied') {
      captureException(new Error('autoBackup: MediaLibrary permission denied'), {
        tags: { area: 'autoBackup', stage: 'permission' },
        extra: { status },
      });
      await saveAutoBackupState({ lastRanAt: Date.now(), failureCount: state.failureCount + 1 });
      return { uploaded: 0, skippedLarge: 0, failed: 1 };
    }
    return empty;
  }

  const since = new Date(state.lastCreatedAt ?? 0);

  const { assets } = await MediaLibrary.getAssetsAsync({
    createdAfter: since,
    mediaType: ['photo', 'video'],
    sortBy: MediaLibrary.SortBy.creationTime,
    first: AUTO_BACKUP_BATCH,
  });

  const backedUpMap = await loadBackedUpMap();

  let uploaded = 0;
  let skippedLarge = 0;
  let failed = 0;
  let maxUploadedCreationTime = 0;

  for (const asset of assets) {
    // Dedup: already backed up in a previous tick.
    if (backedUpMap[asset.id] != null) continue;

    let localUri: string;
    let filename: string;
    // `fileSize` exists at runtime but is absent from the published Asset types;
    // cast to reach it safely (same pattern as gallery.tsx).
    let fileSize = 0;
    try {
      const info = await MediaLibrary.getAssetInfoAsync(asset.id);
      localUri = info.localUri ?? asset.uri;
      filename = info.filename ?? asset.filename;
      fileSize = (info as MediaLibrary.AssetInfo & { fileSize?: number }).fileSize ?? 0;
    } catch (err) {
      captureException(err, {
        tags: { area: 'autoBackup', stage: 'getAssetInfo' },
        extra: { assetId: asset.id, assetUri: asset.uri },
      });
      failed += 1;
      continue;
    }

    // Files >= 5 GB cannot be uploaded in background context; surface them
    // in the Gallery chip so the user can upload manually in the foreground.
    if (fileSize >= BACKGROUND_MAX_BYTES) {
      skippedLarge += 1;
      continue;
    }

    const contentType = guessContentType(filename);
    const remoteKey = autoFolderKey(asset.creationTime, filename);

    try {
      await uploadFileBackground(localUri, remoteKey, contentType, fileSize);
      await recordBackedUp(asset.id, remoteKey).catch((err) =>
        console.warn('autoBackup recordBackedUp failed', asset.id, err),
      );
      uploaded += 1;
      if (asset.creationTime > maxUploadedCreationTime) {
        maxUploadedCreationTime = asset.creationTime;
      }
    } catch (err) {
      console.warn('autoBackup upload failed', remoteKey, err);
      captureException(err, {
        tags: { area: 'autoBackup', stage: 'upload' },
        extra: { remoteKey, assetId: asset.id, fileSize },
      });
      failed += 1;
    }
  }

  // Advance the cursor only based on successfully uploaded assets.
  // Skipped large files and failed uploads do not move it — they will
  // re-surface on the next tick and re-increment largeQueueCount/failureCount.
  const newLastCreatedAt =
    maxUploadedCreationTime > 0
      ? maxUploadedCreationTime - 1000 // 1 s safety buffer
      : state.lastCreatedAt;

  await saveAutoBackupState({
    lastRanAt: Date.now(),
    lastCreatedAt: newLastCreatedAt,
    failureCount: state.failureCount + failed,
    largeQueueCount: skippedLarge,
  });

  return { uploaded, skippedLarge, failed };
}

// Compose the remote key for an auto-backed-up asset.
// Uses device local time (not UTC) so the folder date matches what the user
// sees in their photo app when they took the photo.
function autoFolderKey(creationTimeMs: number, filename: string): string {
  const d = new Date(creationTimeMs);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `auto/${y}-${m}-${day}/${filename}`;
}

// Simple content-type inference for background uploads. Matches the
// CONTENT_TYPE_BY_EXT table in upload.ts; duplicated here to avoid importing
// a map that grows over time — keeping this tiny keeps the background module lean.
function guessContentType(filename: string): string {
  const ext = filename.toLowerCase().split('.').pop() ?? '';
  const MAP: Record<string, string> = {
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
    heic: 'image/heic', heif: 'image/heif', webp: 'image/webp', gif: 'image/gif',
    mp4: 'video/mp4', mov: 'video/quicktime', m4v: 'video/x-m4v',
    avi: 'video/x-msvideo', mkv: 'video/x-matroska',
  };
  return MAP[ext] ?? 'application/octet-stream';
}
