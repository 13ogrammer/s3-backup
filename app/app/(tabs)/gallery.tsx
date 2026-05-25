import { getInfoAsync } from 'expo-file-system/legacy';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import * as MediaLibrary from 'expo-media-library';
import type { AssetInfo } from 'expo-media-library';
import { useNavigation, useRouter } from 'expo-router';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  AppState,
  AppStateStatus,
  Dimensions,
  Linking,
  Pressable,
  SectionList,
  StyleSheet,
  View,
} from 'react-native';

import { useAiFabClearance } from '@/components/ai-fab';
import { DateFilterModal, type DateFilter } from '@/components/date-filter-modal';
import { FolderPicker } from '@/components/folder-picker';
import { SelectionActionBar, type SelectionAction } from '@/components/selection-action-bar';
import { ThemedText } from '@/components/themed-text';
import { Thumb } from '@/components/Thumb';
import { ThemedView } from '@/components/themed-view';
import { IconSymbol } from '@/components/ui/icon-symbol';
import { useAlert } from '@/components/ui/alert-provider';
import { ModalCard } from '@/components/ui/modal-card';
import { Colors, Radius, Spacing, Type } from '@/constants/theme';
import { useColorScheme } from '@/hooks/use-color-scheme';
import { api, ApiError } from '@/lib/api';
import { loadBackedUpMap, recordBackedUp, removeBackedUp, type BackedUpMap } from '@/lib/backedUpState';
import { getLastFolder, loadConfig, setLastFolder } from '@/lib/config';
import { formatBytes } from '@/lib/format';
import { buildGallerySections, type GalleryRow, type GallerySection } from '@/lib/gallerySections';
import { buildMetadataBag } from '@/lib/metadata';
import {
  UploadError,
  inferContentType,
  resumeUpload,
  runWithConcurrency,
  uploadAsset,
} from '@/lib/upload';
import {
  loadPendingUploads,
  removePendingUpload,
  type PendingUpload,
} from '@/lib/uploadState';
import { fromErr, recordUploadFailure, recordUploadSuccess } from '@/lib/activityLog';
import { captureApiError } from '@/lib/sentry';
import { setUploadSessionActive } from '@/lib/uploadSession';

const UPLOAD_CONCURRENCY = 3;
const PAGE_SIZE = 60;

const COLUMNS = 3;
const SPACING = 2;
const TILE = (Dimensions.get('window').width - SPACING * (COLUMNS + 1)) / COLUMNS;

type UploadState = {
  total: number;
  done: number;
  failed: number;
  inFlight: string[];
};

export default function GalleryScreen() {
  const colorScheme = useColorScheme() ?? 'light';
  const colors = Colors[colorScheme];
  const navigation = useNavigation();
  const router = useRouter();
  const { showAlert } = useAlert();
  const { contentPaddingBottom } = useAiFabClearance();

  const [permission, requestPermission] = MediaLibrary.usePermissions({
    granularPermissions: ['photo', 'video'],
  });
  const [assets, setAssets] = useState<MediaLibrary.Asset[]>([]);
  const [loadingAssets, setLoadingAssets] = useState(false);
  const [endCursor, setEndCursor] = useState<string | undefined>(undefined);
  const [hasMore, setHasMore] = useState(true);

  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [pickerVisible, setPickerVisible] = useState(false);
  const [uploadState, setUploadState] = useState<UploadState | null>(null);
  const [lastFolder, setLastFolderState] = useState<string | undefined>(undefined);
  const [pendingResume, setPendingResume] = useState<PendingUpload[]>([]);
  const [backedUpMap, setBackedUpMap] = useState<BackedUpMap>({});
  const [dateFilter, setDateFilter] = useState<DateFilter>({ start: null, end: null });
  const [filterModalVisible, setFilterModalVisible] = useState(false);
  const filterActive = dateFilter.start !== null || dateFilter.end !== null;
  const mountedRef = useRef(false);

  // Cache of assetId → fileSize (bytes), populated lazily as items are selected.
  const fileSizeCacheRef = useRef<Map<string, number>>(new Map());

  useEffect(() => {
    if (permission?.granted) {
      loadInitial();
    }
  }, [permission?.granted]);

  useEffect(() => {
    getLastFolder().then((f) => {
      if (f != null) setLastFolderState(f);
    });
  }, []);

  const refreshPendingResume = useCallback(async () => {
    try {
      const all = await loadPendingUploads();
      const alive: PendingUpload[] = [];
      for (const entry of all) {
        const info = await getInfoAsync(entry.localUri);
        if (info.exists) alive.push(entry);
        else await removePendingUpload(entry.remoteKey).catch(() => undefined);
      }
      setPendingResume(alive);
    } catch (err) {
      console.warn('refreshPendingResume failed', err);
    }
  }, []);

  useEffect(() => {
    refreshPendingResume();
  }, [refreshPendingResume]);

  // Re-check for paused uploads whenever the app returns to the foreground
  // (covers the case where the app was backgrounded mid-upload and relaunched
  // without a full cold start).
  useEffect(() => {
    const sub = AppState.addEventListener('change', (next: AppStateStatus) => {
      if (next === 'active') refreshPendingResume();
    });
    return () => sub.remove();
  }, [refreshPendingResume]);

  useEffect(() => {
    loadBackedUpMap()
      .then(setBackedUpMap)
      .catch((err) => console.warn('loadBackedUpMap failed', err));
  }, []);

  // Reset and reload when the date filter changes, but not on the initial render.
  useEffect(() => {
    if (!mountedRef.current) {
      mountedRef.current = true;
      return;
    }
    setSelectedIds(new Set());
    setAssets([]);
    setEndCursor(undefined);
    setHasMore(true);
    loadInitial(dateFilter);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dateFilter.start?.getTime(), dateFilter.end?.getTime()]);

  useLayoutEffect(() => {
    if (!permission?.granted) {
      navigation.setOptions({ headerRight: undefined });
      return;
    }
    navigation.setOptions({
      headerRight: () => (
        <Pressable
          onPress={() => setFilterModalVisible(true)}
          style={{ paddingRight: Spacing.md }}
          hitSlop={8}>
          <IconSymbol
            name={
              filterActive
                ? 'line.3.horizontal.decrease.circle.fill'
                : 'line.3.horizontal.decrease.circle'
            }
            size={22}
            color={filterActive ? colors.tint : colors.icon}
          />
        </Pressable>
      ),
    });
  }, [permission?.granted, filterActive, dateFilter, navigation, colors.tint, colors.icon]);

  const uploading = uploadState !== null;
  useEffect(() => {
    if (!uploading) return;
    activateKeepAwakeAsync('s3backup.upload').catch(() => {});
    return () => {
      deactivateKeepAwake('s3backup.upload');
    };
  }, [uploading]);

  async function loadInitial(filter?: DateFilter) {
    const activeFilter = filter ?? dateFilter;
    setLoadingAssets(true);
    try {
      const page = await MediaLibrary.getAssetsAsync({
        mediaType: ['photo', 'video'],
        first: PAGE_SIZE,
        sortBy: [MediaLibrary.SortBy.creationTime],
        ...(activeFilter.start != null ? { createdAfter: activeFilter.start } : {}),
        ...(activeFilter.end != null ? { createdBefore: activeFilter.end } : {}),
      });
      setAssets(page.assets);
      setEndCursor(page.endCursor);
      setHasMore(page.hasNextPage);
    } finally {
      setLoadingAssets(false);
    }
  }

  async function loadMore() {
    if (loadingAssets || !hasMore) return;
    setLoadingAssets(true);
    try {
      const page = await MediaLibrary.getAssetsAsync({
        mediaType: ['photo', 'video'],
        first: PAGE_SIZE,
        after: endCursor,
        sortBy: [MediaLibrary.SortBy.creationTime],
        ...(dateFilter.start != null ? { createdAfter: dateFilter.start } : {}),
        ...(dateFilter.end != null ? { createdBefore: dateFilter.end } : {}),
      });
      setAssets((prev) => [...prev, ...page.assets]);
      setEndCursor(page.endCursor);
      setHasMore(page.hasNextPage);
    } finally {
      setLoadingAssets(false);
    }
  }

  function toggle(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function clearSelection() {
    setSelectedIds(new Set());
  }

  const sections = useMemo(
    () => buildGallerySections(assets, new Date(), { excludeUnknown: filterActive }),
    [assets, filterActive],
  );

  function isSectionFullySelected(section: GallerySection): boolean {
    return section.assetIds.length > 0 && section.assetIds.every((id) => selectedIds.has(id));
  }

  function toggleSection(section: GallerySection): void {
    if (isSectionFullySelected(section)) {
      setSelectedIds((prev) => {
        const next = new Set(prev);
        section.assetIds.forEach((id) => next.delete(id));
        return next;
      });
    } else {
      setSelectedIds((prev) => {
        const next = new Set(prev);
        section.assetIds.forEach((id) => next.add(id));
        return next;
      });
    }
  }

  async function onTapUpload() {
    if (selectedIds.size === 0) return;
    const cfg = await loadConfig();
    if (!cfg) {
      showAlert('Not configured', 'Open Settings and add your backend URL + token.');
      return;
    }
    setPickerVisible(true);
  }

  async function doDeleteFromDevice(eligibleIds: string[]): Promise<void> {
    const deletedSet = new Set(eligibleIds);
    let success: boolean;
    try {
      success = await MediaLibrary.deleteAssetsAsync(eligibleIds);
    } catch (err) {
      showAlert('Could not delete', describeError(err));
      return;
    }
    if (!success) {
      showAlert('Could not delete', 'The system reported that deletion failed. No items were removed.');
      return;
    }
    setAssets((prev) => prev.filter((a) => !deletedSet.has(a.id)));
    setSelectedIds((prev) => {
      const next = new Set(prev);
      eligibleIds.forEach((id) => next.delete(id));
      return next;
    });
    setBackedUpMap((prev) => {
      const next = { ...prev };
      eligibleIds.forEach((id) => delete next[id]);
      return next;
    });
    await removeBackedUp(eligibleIds).catch((err) =>
      console.warn('removeBackedUp failed after device delete', err),
    );
  }

  function onTapDeleteFromDevice(): void {
    const eligibleIds = eligibleForDeviceDelete(selectedIds, backedUpMap);
    const n = eligibleIds.length;
    if (n === 0) return;
    const label = n === 1 ? '1 item' : `${n} items`;
    const skipped = selectedCount - n;
    const body =
      skipped > 0
        ? `${n} of ${selectedCount} selected items are backed up and eligible for deletion from this device. The remaining ${skipped} will be skipped. These items will be removed from this device's photo library. This cannot be undone — the originals will only exist in your bucket.`
        : 'These items are backed up to S3 and will be removed from this device\'s photo library. This cannot be undone — the originals will only exist in your bucket.';
    showAlert(
      `Delete ${label} from this device?`,
      body,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () => doDeleteFromDevice(eligibleIds),
        },
      ],
      { cancelable: true },
    );
  }

  async function onPickFolder(prefix: string) {
    setPickerVisible(false);
    setLastFolderState(prefix);
    setLastFolder(prefix).catch((err) =>
      console.warn('failed to persist last folder', err),
    );
    await uploadSelected(prefix);
  }

  async function onResumePending() {
    const cfg = await loadConfig();
    if (!cfg) {
      showAlert('Not configured', 'Open Settings and add your backend URL + token.');
      return;
    }
    const items = pendingResume;
    if (items.length === 0) return;

    setUploadState({ total: items.length, done: 0, failed: 0, inFlight: [] });

    try {
      setUploadSessionActive(true);
      const failed = await runWithConcurrency(
        items,
        async (entry) => {
          const filename = filenameForKey(entry.remoteKey);
          setUploadState((s) => (s ? { ...s, inFlight: [...s.inFlight, filename] } : s));
          try {
            await resumeUpload(entry);
            setUploadState((s) =>
              s
                ? {
                    ...s,
                    done: s.done + 1,
                    inFlight: s.inFlight.filter((n) => n !== filename),
                  }
                : s,
            );
          } catch (err) {
            captureApiError(err);
            await recordUploadFailure({
              remoteKey: entry.remoteKey,
              localUri: entry.localUri,
              sizeBytes: entry.totalBytes,
              ...fromErr(err),
            }).catch(() => undefined);
            setUploadState((s) =>
              s
                ? {
                    ...s,
                    failed: s.failed + 1,
                    inFlight: s.inFlight.filter((n) => n !== filename),
                  }
                : s,
            );
            throw err;
          }
        },
        UPLOAD_CONCURRENCY,
      );

      setUploadState(null);

      await refreshPendingResume();

      if (failed.length === 0) {
        showAlert('Resume complete', `${items.length} upload(s) finished.`);
        return;
      }
      showAlert(
        'Some resumes failed',
        `${items.length - failed.length}/${items.length} finished. The rest stay queued. View details to retry.`,
        [
          { text: 'View details', onPress: () => router.push('/(tabs)/activity') },
          { text: 'OK', style: 'cancel' },
        ],
      );
      return;
    } finally {
      setUploadSessionActive(false);
    }
  }

  async function doDiscardPending(items: typeof pendingResume) {
    for (const entry of items) {
      if (entry.kind === 'multipart') {
        try {
          await api.abortMultipart(entry.remoteKey, entry.uploadId);
        } catch (err) {
          console.warn('discard abort failed', entry.remoteKey, err);
        }
      }
      // Simple entries have no server-side multipart session to abort.
      await removePendingUpload(entry.remoteKey).catch(() => undefined);
    }
    setPendingResume([]);
  }

  function onDiscardPending() {
    const items = pendingResume;
    if (items.length === 0) return;
    showAlert(
      'Discard paused uploads?',
      `${items.length} in-flight upload(s) will be aborted on the server. The originals stay on your device.`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Discard', style: 'destructive', onPress: () => doDiscardPending(items) },
      ],
      { cancelable: true },
    );
  }

  async function runUpload(
    prefix: string,
    toUpload: Array<{ asset: MediaLibrary.Asset; filename: string }>,
  ) {
    setUploadState({
      total: toUpload.length,
      done: 0,
      failed: 0,
      inFlight: [],
    });

    let failed: Array<{ item: typeof toUpload[number]; error: unknown }>;
    try {
      setUploadSessionActive(true);
      failed = await runWithConcurrency(
        toUpload,
        async (entry) => {
          const { asset, filename } = entry;
          // iOS gives a ph:// URI in the asset list — getAssetInfoAsync resolves
          // to a readable file://. On Android the call is also needed to get
          // the un-redacted localUri that preserves EXIF GPS (the plain
          // asset.uri is stripped unless ACCESS_MEDIA_LOCATION is granted, which
          // the expo-media-library plugin does via isAccessMediaLocationEnabled).
          const info = await MediaLibrary.getAssetInfoAsync(asset.id);
          const localUri = info.localUri || asset.uri;
          const contentType = inferContentType(filename, asset.mediaType);
          const key = prefix + filename;
          const mediaKind: 'image' | 'video' | 'other' =
            asset.mediaType === 'photo'
              ? 'image'
              : asset.mediaType === 'video'
                ? 'video'
                : 'other';

          setUploadState((s) =>
            s ? { ...s, inFlight: [...s.inFlight, filename] } : s,
          );
          try {
            // Build metadata bag from media-library + EXIF before upload.
            // EXIF parse failure inside buildMetadataBag is non-fatal — it
            // returns a partial bag from media-library data in that case.
            const metadata = await buildMetadataBag(localUri, asset, info, mediaKind).catch((err) => {
              console.warn('buildMetadataBag failed, uploading without metadata', err);
              return undefined;
            });
            await uploadAsset(localUri, key, contentType, mediaKind, undefined, metadata);
            await recordUploadSuccess({
              remoteKey: key,
              sizeBytes: fileSizeCacheRef.current.get(asset.id) ?? 0,
            }).catch(() => undefined);
            try {
              await recordBackedUp(asset.id, key);
            } catch (err) {
              console.warn('recordBackedUp failed', asset.id, err);
            }
            setBackedUpMap((prev) => ({ ...prev, [asset.id]: key }));
            setUploadState((s) =>
              s
                ? {
                    ...s,
                    done: s.done + 1,
                    inFlight: s.inFlight.filter((n) => n !== filename),
                  }
                : s,
            );
          } catch (err) {
            captureApiError(err);
            await recordUploadFailure({
              remoteKey: key,
              localUri,
              sizeBytes: fileSizeCacheRef.current.get(asset.id) ?? 0,
              ...fromErr(err),
            }).catch(() => undefined);
            setUploadState((s) =>
              s
                ? {
                    ...s,
                    failed: s.failed + 1,
                    inFlight: s.inFlight.filter((n) => n !== filename),
                  }
                : s,
            );
            throw err;
          }
        },
        UPLOAD_CONCURRENCY,
      );
    } finally {
      setUploadSessionActive(false);
    }

    setUploadState(null);

    if (failed.length === 0) {
      clearSelection();
      showAlert('Upload complete', `${toUpload.length} item(s) uploaded to /${prefix}.`);
      return;
    }

    // Keep just the failed ones selected for retry.
    const failedIds = new Set(failed.map(({ item }) => item.asset.id));
    setSelectedIds(failedIds);
    const succeeded = toUpload.length - failed.length;
    const sample = failed
      .slice(0, 3)
      .map(({ item, error }) => `• ${item.filename}: ${describeError(error)}`)
      .join('\n');
    const more = failed.length > 3 ? `\n…and ${failed.length - 3} more.` : '';
    showAlert(
      'Some uploads failed',
      `${succeeded}/${toUpload.length} succeeded, ${failed.length} failed. Failed items kept selected so you can retry.\n\n${sample}${more}`,
      [
        { text: 'View details', onPress: () => router.push('/(tabs)/activity') },
        { text: 'OK', style: 'cancel' },
      ],
    );
  }

  async function uploadSelected(prefix: string) {
    const chosen = assets.filter((a) => selectedIds.has(a.id));
    if (chosen.length === 0) return;

    const plan = chosen.map((asset) => ({
      asset,
      filename: filenameFor(asset),
    }));
    const destKeys = plan.map((p) => prefix + p.filename);

    try {
      const { existing } = await api.exists(destKeys);
      if (existing.length > 0) {
        // Show the collision dialog and continue in its callback to keep the
        // upload flow in sync with the user's choice.
        promptForCollision(existing.length, plan.length, (choice) => {
          if (choice === 'cancel') return;
          if (choice === 'skip') {
            const existingSet = new Set(existing);
            const filtered = plan.filter((p) => !existingSet.has(prefix + p.filename));
            if (filtered.length === 0) {
              showAlert('Nothing to upload', 'All selected items already exist.');
              return;
            }
            runUpload(prefix, filtered).catch(console.warn);
          } else {
            runUpload(prefix, plan).catch(console.warn);
          }
        });
        return;
      }
    } catch (err) {
      console.warn('pre-flight /exists failed', err);
    }

    await runUpload(prefix, plan);
  }

  function promptForCollision(
    existingCount: number,
    totalCount: number,
    onResult: (choice: 'skip' | 'overwrite' | 'cancel') => void,
  ): void {
    const remaining = totalCount - existingCount;
    const message =
      existingCount === totalCount
        ? `All ${existingCount} selected item(s) already exist in this folder.`
        : `${existingCount} of ${totalCount} selected item(s) already exist in this folder.`;
    showAlert(
      'Items already exist',
      `${message}\n\nSkip existing (upload ${remaining}), overwrite them, or cancel?`,
      [
        { text: 'Cancel', style: 'cancel', onPress: () => onResult('cancel') },
        { text: 'Skip existing', onPress: () => onResult('skip') },
        {
          text: 'Overwrite',
          style: 'destructive',
          onPress: () => onResult('overwrite'),
        },
      ],
      { cancelable: true },
    );
  }

  const selectedCount = selectedIds.size;

  // Fetch fileSize for newly-selected asset ids we haven't seen before.
  // getAssetInfoAsync is called per-id; results are cached to avoid repeat
  // network hits on re-renders or deselect/reselect cycles.
  const [selectionBytes, setSelectionBytes] = useState(0);
  useEffect(() => {
    if (selectedIds.size === 0) {
      setSelectionBytes(0);
      return;
    }

    let cancelled = false;
    const timer = setTimeout(async () => {
      const cache = fileSizeCacheRef.current;
      const toFetch: string[] = [];
      for (const id of selectedIds) {
        if (!cache.has(id)) toFetch.push(id);
      }
      for (const id of toFetch) {
        if (cancelled) return;
        try {
          const info = await MediaLibrary.getAssetInfoAsync(id);
          // `fileSize` exists at runtime on both platforms but is absent from
          // the published TypeScript types — cast to reach it safely.
          let size: number | undefined = (info as AssetInfo & { fileSize?: number }).fileSize;
          // Android's MediaLibrary often omits fileSize; fall back to a
          // filesystem stat on the local URI so the selection bar shows bytes.
          if (size == null && info.localUri) {
            const stat = await getInfoAsync(info.localUri);
            if (stat.exists && typeof stat.size === 'number') size = stat.size;
          }
          if (cancelled) return;
          cache.set(id, size ?? 0);
        } catch {
          cache.set(id, 0);
        }
      }
      if (cancelled) return;
      let total = 0;
      for (const id of selectedIds) {
        total += cache.get(id) ?? 0;
      }
      setSelectionBytes(total);
    }, 150);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  // selectedIds is a Set so we stringify the size + a stable key to detect changes.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedIds]);

  const pendingBytesRemaining = pendingResume.reduce((sum, e) => {
    if (e.kind === 'simple') {
      return sum + e.totalBytes;
    }
    const done = e.completedParts.reduce((b, p) => {
      const offset = (p.partNumber - 1) * e.partSize;
      return b + Math.min(e.partSize, Math.max(0, e.totalBytes - offset));
    }, 0);
    return sum + Math.max(0, e.totalBytes - done);
  }, 0);

  const allSimple =
    pendingResume.length > 0 && pendingResume.every((e) => e.kind === 'simple');

  if (!permission) {
    return (
      <ThemedView style={[styles.container, styles.center]}>
        <ActivityIndicator />
      </ThemedView>
    );
  }

  if (!permission.granted) {
    return (
      <ThemedView style={[styles.container, styles.center, { padding: 24, gap: 12 }]}>
        <ThemedText type="subtitle">Photo access needed</ThemedText>
        <ThemedText style={{ textAlign: 'center', opacity: 0.7 }}>
          We need permission to read your photos and videos so you can choose what to back up.
        </ThemedText>
        {permission.canAskAgain ? (
          <Pressable
            onPress={() => requestPermission()}
            style={({ pressed }) => [
              styles.primaryButton,
              { backgroundColor: colors.tint, opacity: pressed ? 0.7 : 1 },
            ]}>
            <ThemedText style={[styles.primaryButtonText, { color: colors.onAccent }]}>
              Grant access
            </ThemedText>
          </Pressable>
        ) : (
          <Pressable
            onPress={() => Linking.openSettings()}
            style={({ pressed }) => [
              styles.primaryButton,
              { backgroundColor: colors.tint, opacity: pressed ? 0.7 : 1 },
            ]}>
            <ThemedText style={[styles.primaryButtonText, { color: colors.onAccent }]}>
              Open system Settings
            </ThemedText>
          </Pressable>
        )}
      </ThemedView>
    );
  }

  return (
    <ThemedView style={styles.container}>
      {pendingResume.length > 0 && !uploadState && (
        <View
          style={[
            styles.resumeBanner,
            { backgroundColor: colors.accentSoft, borderColor: colors.icon },
          ]}>
          <View style={{ flex: 1 }}>
            <ThemedText type="defaultSemiBold" style={{ color: colors.tint }}>
              {pendingResume.length} upload{pendingResume.length === 1 ? '' : 's'} paused
            </ThemedText>
            <ThemedText style={{ fontSize: 12, opacity: 0.75 }}>
              {formatBytes(pendingBytesRemaining)} left to send
            </ThemedText>
          </View>
          <Pressable
            onPress={onDiscardPending}
            style={({ pressed }) => [
              styles.chip,
              { backgroundColor: colors.surfaceMuted, opacity: pressed ? 0.7 : 1 },
            ]}>
            <ThemedText>Discard</ThemedText>
          </Pressable>
          <Pressable
            onPress={onResumePending}
            style={({ pressed }) => [
              styles.chip,
              { backgroundColor: colors.tint, opacity: pressed ? 0.7 : 1 },
            ]}>
            <ThemedText style={{ color: colors.onAccent, fontWeight: '600' }}>
              {allSimple ? 'Retry' : 'Resume'}
            </ThemedText>
          </Pressable>
        </View>
      )}

      {filterActive && (
        <View
          style={[
            styles.filterBadgeRow,
            { backgroundColor: colors.accentSoft, borderColor: colors.border },
          ]}>
          <Pressable onPress={() => setFilterModalVisible(true)} style={{ flex: 1 }}>
            <ThemedText style={[styles.filterBadgeText, { color: colors.tint }]}>
              {formatFilterLabel(dateFilter)}
            </ThemedText>
          </Pressable>
          <Pressable
            onPress={() => setDateFilter({ start: null, end: null })}
            hitSlop={8}
            style={{ paddingLeft: Spacing.sm }}>
            <ThemedText style={{ color: colors.tint, ...Type.body }}>×</ThemedText>
          </Pressable>
        </View>
      )}

      <SectionList<GalleryRow, GallerySection>
        sections={sections}
        stickySectionHeadersEnabled={false}
        keyExtractor={(row, index) => row.find(Boolean)?.id ?? String(index)}
        contentContainerStyle={{ padding: SPACING, paddingBottom: contentPaddingBottom }}
        onEndReached={loadMore}
        onEndReachedThreshold={0.5}
        ListEmptyComponent={
          loadingAssets ? null : (
            <ThemedText style={styles.empty}>
              {filterActive
                ? 'No photos or videos in this date range.'
                : 'No photos or videos on this device.'}
            </ThemedText>
          )
        }
        ListFooterComponent={
          loadingAssets && hasMore ? (
            <View style={{ padding: 16 }}>
              <ActivityIndicator />
            </View>
          ) : null
        }
        renderSectionHeader={({ section }) => {
          const allSelected = isSectionFullySelected(section);
          return (
            <Pressable
              onPress={() => toggleSection(section)}
              style={[styles.sectionHeader, { backgroundColor: colors.surfaceMuted }]}>
              <ThemedText style={[styles.sectionHeaderLabel, { color: colors.text }]}>
                {section.title}
              </ThemedText>
              <View
                style={[
                  styles.sectionSelectIndicator,
                  allSelected
                    ? { backgroundColor: colors.tint, borderColor: colors.tint }
                    : { borderColor: colors.icon },
                ]}>
                {allSelected && (
                  <ThemedText lightColor="#fff" darkColor="#000" style={styles.checkmarkText}>
                    ✓
                  </ThemedText>
                )}
              </View>
            </Pressable>
          );
        }}
        renderItem={({ item: row }) => (
          <View style={styles.row}>
            {row.map((cell, cellIndex) =>
              cell !== null ? (
                <Pressable
                  key={cell.id}
                  onPress={() => toggle(cell.id)}
                  style={{ width: TILE, height: TILE }}>
                  <Thumb
                    uri={cell.uri}
                    width={TILE}
                    height={TILE}
                    borderRadius={4}
                    recyclingKey={cell.id}
                    style={backedUpMap[cell.id] != null ? styles.backedUpImage : undefined}
                  />
                  {cell.mediaType === 'video' && (
                    <View style={styles.videoBadge}>
                      <ThemedText style={styles.videoBadgeText}>VIDEO</ThemedText>
                    </View>
                  )}
                  {backedUpMap[cell.id] != null && (
                    <View
                      style={[
                        styles.backedUpBadge,
                        { backgroundColor: colors.surfaceElevated },
                      ]}>
                      <IconSymbol
                        name="checkmark.icloud.fill"
                        size={14}
                        color={colors.tint}
                      />
                    </View>
                  )}
                  {selectedIds.has(cell.id) && (
                    <View style={[styles.selectedOverlay, { borderColor: colors.tint }]}>
                      <View style={[styles.checkmark, { backgroundColor: colors.tint }]}>
                        <ThemedText
                          lightColor="#fff"
                          darkColor="#000"
                          style={styles.checkmarkText}>
                          ✓
                        </ThemedText>
                      </View>
                    </View>
                  )}
                </Pressable>
              ) : (
                <View key={`placeholder-${cellIndex}`} style={{ width: TILE, height: TILE }} />
              ),
            )}
          </View>
        )}
      />

      {selectedCount > 0 && (
        <SelectionActionBar
          statusLabel={`${selectedCount} selected${selectionBytes > 0 ? ` · ${formatBytes(selectionBytes)}` : ''}`}
          actions={galleryActions(
            onTapUpload,
            onTapDeleteFromDevice,
            uploading,
            eligibleForDeviceDelete(selectedIds, backedUpMap).length,
          )}
          onDismiss={clearSelection}
          dismissAccessibilityLabel="Exit selection mode"
        />
      )}

      <DateFilterModal
        visible={filterModalVisible}
        value={dateFilter}
        onApply={(next) => {
          setFilterModalVisible(false);
          setDateFilter(next);
        }}
        onClear={() => {
          setFilterModalVisible(false);
          setDateFilter({ start: null, end: null });
        }}
        onClose={() => setFilterModalVisible(false)}
      />

      <FolderPicker
        visible={pickerVisible}
        onClose={() => setPickerVisible(false)}
        onPick={onPickFolder}
        initialPath={lastFolder}
      />

      {/* dismissOnBackdrop=false + no-op onRequestClose so Android back
          button cannot cancel an in-progress upload accidentally. */}
      <ModalCard
        visible={uploadState !== null}
        onRequestClose={() => {}}
        dismissOnBackdrop={false}>
        <View style={styles.uploadContent}>
          <ActivityIndicator />
          <ThemedText type="defaultSemiBold">
            Uploading {uploadState?.done} / {uploadState?.total}
          </ThemedText>
          <View style={styles.progressBarBg}>
            <View
              style={[
                styles.progressBarFill,
                {
                  backgroundColor: colors.tint,
                  width: `${Math.min(
                    100,
                    Math.round(((uploadState?.done ?? 0) / (uploadState?.total ?? 1)) * 100),
                  )}%`,
                },
              ]}
            />
          </View>
          {(uploadState?.inFlight.length ?? 0) > 0 && (
            <ThemedText style={{ opacity: 0.65, fontSize: 12 }} numberOfLines={3}>
              In flight: {uploadState?.inFlight.join(', ')}
            </ThemedText>
          )}
          <ThemedText
            style={{ opacity: 0.55, fontSize: 11, textAlign: 'center' }}>
            Keep the app open — uploads pause if you switch away.
          </ThemedText>
        </View>
      </ModalCard>
    </ThemedView>
  );
}

function galleryActions(
  onUpload: () => void,
  onDelete: () => void,
  uploading: boolean,
  eligibleCount: number,
): SelectionAction[] {
  return [
    {
      key: 'upload',
      icon: 'arrow.up',
      accessibilityLabel: 'Upload selected items',
      onPress: onUpload,
    },
    {
      key: 'delete',
      icon: 'trash',
      accessibilityLabel: 'Delete from device',
      onPress: onDelete,
      disabled: uploading || eligibleCount === 0,
      tone: 'danger',
    },
  ];
}

function eligibleForDeviceDelete(
  selectedIds: Set<string>,
  backedUpMap: BackedUpMap,
): string[] {
  const ids: string[] = [];
  for (const id of selectedIds) {
    if (backedUpMap[id] != null) ids.push(id);
  }
  return ids;
}

function formatFilterLabel(filter: DateFilter): string {
  const fmt = (d: Date) =>
    d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  const fmtYear = (d: Date) =>
    d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });

  const { start, end } = filter;
  if (start && end) {
    if (start.toDateString() === end.toDateString()) return fmtYear(start);
    return `${fmt(start)} – ${fmt(end)}`;
  }
  if (start) return `From ${fmt(start)}`;
  if (end) return `Until ${fmt(end)}`;
  return '';
}

function describeError(err: unknown): string {
  if (err instanceof UploadError) return `HTTP ${err.status}`;
  if (err instanceof ApiError) return `(${err.status}) ${err.message}`;
  if (err instanceof Error) return err.message;
  return 'Unknown error';
}

function filenameForKey(remoteKey: string): string {
  const idx = remoteKey.lastIndexOf('/');
  return idx === -1 ? remoteKey : remoteKey.slice(idx + 1);
}

function filenameFor(asset: MediaLibrary.Asset): string {
  if (asset.filename) return asset.filename;
  const ext = asset.mediaType === 'video' ? 'mp4' : 'jpg';
  return `media_${asset.id}.${ext}`;
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  center: { alignItems: 'center', justifyContent: 'center' },
  empty: { textAlign: 'center', opacity: 0.6, padding: 32 },
  row: {
    flexDirection: 'row',
    gap: SPACING,
    marginBottom: SPACING,
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm,
    marginBottom: SPACING,
  },
  sectionHeaderLabel: {
    ...Type.label,
  },
  sectionSelectIndicator: {
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  backedUpImage: {
    opacity: 0.45,
  },
  backedUpBadge: {
    position: 'absolute',
    bottom: 4,
    right: 4,
    padding: 2,
    borderRadius: Radius.sm,
  },
  videoBadge: {
    position: 'absolute',
    bottom: 4,
    left: 4,
    backgroundColor: 'rgba(0,0,0,0.65)',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
  },
  videoBadgeText: { color: '#fff', fontSize: 10, fontWeight: '700' },
  selectedOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    borderWidth: 3,
    borderRadius: 4,
  },
  checkmark: {
    position: 'absolute',
    top: 4,
    right: 4,
    width: 22,
    height: 22,
    borderRadius: 11,
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkmarkText: { fontWeight: '700', fontSize: 14 },
  chip: {
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm,
    borderRadius: Radius.md,
  },
  primaryButton: {
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.sm,
    borderRadius: Radius.md,
  },
  primaryButtonText: { fontWeight: '600' as const, fontSize: 14 },
  uploadContent: {
    gap: Spacing.sm,
    alignItems: 'center',
  },
  progressBarBg: {
    width: '100%',
    height: 6,
    borderRadius: 3,
    backgroundColor: 'rgba(0,0,0,0.1)',
    overflow: 'hidden',
  },
  progressBarFill: { height: '100%' },
  resumeBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  filterBadgeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderRadius: Radius.pill,
    marginHorizontal: Spacing.md,
    marginVertical: Spacing.xs,
  },
  filterBadgeText: {
    ...Type.label,
  },
});
