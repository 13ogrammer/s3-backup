import { getInfoAsync } from 'expo-file-system/legacy';
import { Image } from 'expo-image';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import * as MediaLibrary from 'expo-media-library';
import { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Dimensions,
  Linking,
  Pressable,
  SectionList,
  StyleSheet,
  View,
} from 'react-native';

import { FolderPicker } from '@/components/folder-picker';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { IconSymbol } from '@/components/ui/icon-symbol';
import { Colors, Radius, Shadow, Spacing, Type } from '@/constants/theme';
import { useColorScheme } from '@/hooks/use-color-scheme';
import { api, ApiError } from '@/lib/api';
import { loadBackedUpMap, recordBackedUp, type BackedUpMap } from '@/lib/backedUpState';
import { getLastFolder, loadConfig, setLastFolder } from '@/lib/config';
import { formatBytes } from '@/lib/format';
import { buildGallerySections, type GalleryRow, type GallerySection } from '@/lib/gallerySections';
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
  type PendingMultipartUpload,
} from '@/lib/uploadState';

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
  const [pendingResume, setPendingResume] = useState<PendingMultipartUpload[]>([]);
  const [backedUpMap, setBackedUpMap] = useState<BackedUpMap>({});

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

  useEffect(() => {
    refreshPendingResume();
  }, []);

  useEffect(() => {
    loadBackedUpMap()
      .then(setBackedUpMap)
      .catch((err) => console.warn('loadBackedUpMap failed', err));
  }, []);

  const uploading = uploadState !== null;
  useEffect(() => {
    if (!uploading) return;
    activateKeepAwakeAsync('s3backup.upload').catch(() => {});
    return () => {
      deactivateKeepAwake('s3backup.upload');
    };
  }, [uploading]);

  async function refreshPendingResume() {
    try {
      const all = await loadPendingUploads();
      const alive: PendingMultipartUpload[] = [];
      for (const entry of all) {
        const info = await getInfoAsync(entry.localUri);
        if (info.exists) alive.push(entry);
        else await removePendingUpload(entry.remoteKey).catch(() => undefined);
      }
      setPendingResume(alive);
    } catch (err) {
      console.warn('refreshPendingResume failed', err);
    }
  }

  async function loadInitial() {
    setLoadingAssets(true);
    try {
      const page = await MediaLibrary.getAssetsAsync({
        mediaType: ['photo', 'video'],
        first: PAGE_SIZE,
        sortBy: [MediaLibrary.SortBy.creationTime],
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

  const sections = useMemo(() => buildGallerySections(assets, new Date()), [assets]);

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
      Alert.alert('Not configured', 'Open Settings and add your backend URL + token.');
      return;
    }
    setPickerVisible(true);
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
      Alert.alert('Not configured', 'Open Settings and add your backend URL + token.');
      return;
    }
    const items = pendingResume;
    if (items.length === 0) return;

    setUploadState({ total: items.length, done: 0, failed: 0, inFlight: [] });

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
      Alert.alert('Resume complete', `${items.length} upload(s) finished.`);
      return;
    }
    Alert.alert(
      'Some resumes failed',
      `${items.length - failed.length}/${items.length} finished. The rest stay queued — try again later.`,
    );
  }

  async function onDiscardPending() {
    const items = pendingResume;
    if (items.length === 0) return;
    const confirmed = await new Promise<boolean>((resolve) => {
      Alert.alert(
        'Discard paused uploads?',
        `${items.length} in-flight upload(s) will be aborted on the server. The originals stay on your device.`,
        [
          { text: 'Cancel', style: 'cancel', onPress: () => resolve(false) },
          { text: 'Discard', style: 'destructive', onPress: () => resolve(true) },
        ],
        { cancelable: true, onDismiss: () => resolve(false) },
      );
    });
    if (!confirmed) return;
    for (const entry of items) {
      try {
        await api.abortMultipart(entry.remoteKey, entry.uploadId);
      } catch (err) {
        console.warn('discard abort failed', entry.remoteKey, err);
      }
      await removePendingUpload(entry.remoteKey).catch(() => undefined);
    }
    setPendingResume([]);
  }

  async function uploadSelected(prefix: string) {
    const chosen = assets.filter((a) => selectedIds.has(a.id));
    if (chosen.length === 0) return;

    const plan = chosen.map((asset) => ({
      asset,
      filename: filenameFor(asset),
    }));
    const destKeys = plan.map((p) => prefix + p.filename);
    let toUpload = plan;
    try {
      const { existing } = await api.exists(destKeys);
      if (existing.length > 0) {
        const choice = await promptForCollision(existing.length, plan.length);
        if (choice === 'cancel') return;
        if (choice === 'skip') {
          const existingSet = new Set(existing);
          toUpload = plan.filter((p) => !existingSet.has(prefix + p.filename));
          if (toUpload.length === 0) {
            Alert.alert('Nothing to upload', 'All selected items already exist.');
            return;
          }
        }
      }
    } catch (err) {
      console.warn('pre-flight /exists failed', err);
    }

    setUploadState({
      total: toUpload.length,
      done: 0,
      failed: 0,
      inFlight: [],
    });

    const failed = await runWithConcurrency(
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
          await uploadAsset(localUri, key, contentType, mediaKind);
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

    if (failed.length === 0) {
      clearSelection();
      Alert.alert('Upload complete', `${toUpload.length} item(s) uploaded to /${prefix}.`);
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
    Alert.alert(
      'Some uploads failed',
      `${succeeded}/${toUpload.length} succeeded, ${failed.length} failed. Failed items kept selected so you can retry.\n\n${sample}${more}`,
    );
  }

  async function promptForCollision(
    existingCount: number,
    totalCount: number,
  ): Promise<'skip' | 'overwrite' | 'cancel'> {
    return new Promise((resolve) => {
      const remaining = totalCount - existingCount;
      const message =
        existingCount === totalCount
          ? `All ${existingCount} selected item(s) already exist in this folder.`
          : `${existingCount} of ${totalCount} selected item(s) already exist in this folder.`;
      Alert.alert(
        'Items already exist',
        `${message}\n\nSkip existing (upload ${remaining}), overwrite them, or cancel?`,
        [
          { text: 'Cancel', style: 'cancel', onPress: () => resolve('cancel') },
          { text: 'Skip existing', onPress: () => resolve('skip') },
          {
            text: 'Overwrite',
            style: 'destructive',
            onPress: () => resolve('overwrite'),
          },
        ],
        { cancelable: true, onDismiss: () => resolve('cancel') },
      );
    });
  }

  const selectedCount = selectedIds.size;

  const pendingBytesRemaining = pendingResume.reduce((sum, e) => {
    const done = e.completedParts.reduce((b, p) => {
      const offset = (p.partNumber - 1) * e.partSize;
      return b + Math.min(e.partSize, Math.max(0, e.totalBytes - offset));
    }, 0);
    return sum + Math.max(0, e.totalBytes - done);
  }, 0);

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
              Resume
            </ThemedText>
          </Pressable>
        </View>
      )}

      <SectionList<GalleryRow, GallerySection>
        sections={sections}
        stickySectionHeadersEnabled={false}
        keyExtractor={(row, index) => row.find(Boolean)?.id ?? String(index)}
        contentContainerStyle={{ padding: SPACING }}
        onEndReached={loadMore}
        onEndReachedThreshold={0.5}
        ListEmptyComponent={
          loadingAssets ? null : (
            <ThemedText style={styles.empty}>No photos or videos on this device.</ThemedText>
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
                  <Image
                    source={{ uri: cell.uri }}
                    style={[
                      { width: TILE, height: TILE, borderRadius: 4 },
                      backedUpMap[cell.id] != null && styles.backedUpImage,
                    ]}
                    contentFit="cover"
                    recyclingKey={cell.id}
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
        <View style={[styles.bottomBar, { backgroundColor: colors.background, borderColor: colors.icon }]}>
          <View style={{ flex: 1 }}>
            <ThemedText type="defaultSemiBold">
              {selectedCount} selected
            </ThemedText>
            <Pressable onPress={clearSelection}>
              <ThemedText style={{ color: colors.tint, fontSize: 13 }}>Clear</ThemedText>
            </Pressable>
          </View>
          <Pressable
            onPress={onTapUpload}
            style={({ pressed }) => [
              styles.primaryButton,
              { backgroundColor: colors.tint, opacity: pressed ? 0.7 : 1 },
            ]}>
            <ThemedText style={[styles.primaryButtonText, { color: colors.onAccent }]}>
              Upload…
            </ThemedText>
          </Pressable>
        </View>
      )}

      <FolderPicker
        visible={pickerVisible}
        onClose={() => setPickerVisible(false)}
        onPick={onPickFolder}
        initialPath={lastFolder}
      />

      {uploadState && (
        <View style={styles.uploadOverlay}>
          <ThemedView style={styles.uploadCard}>
            <ActivityIndicator />
            <ThemedText type="defaultSemiBold">
              Uploading {uploadState.done} / {uploadState.total}
            </ThemedText>
            <View style={styles.progressBarBg}>
              <View
                style={[
                  styles.progressBarFill,
                  {
                    backgroundColor: colors.tint,
                    width: `${Math.min(
                      100,
                      Math.round((uploadState.done / uploadState.total) * 100),
                    )}%`,
                  },
                ]}
              />
            </View>
            {uploadState.inFlight.length > 0 && (
              <ThemedText style={{ opacity: 0.65, fontSize: 12 }} numberOfLines={3}>
                In flight: {uploadState.inFlight.join(', ')}
              </ThemedText>
            )}
            <ThemedText
              style={{ opacity: 0.55, fontSize: 11, textAlign: 'center' }}>
              Keep the app open — uploads pause if you switch away.
            </ThemedText>
          </ThemedView>
        </View>
      )}
    </ThemedView>
  );
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
  bottomBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  primaryButton: {
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.sm,
    borderRadius: Radius.md,
  },
  primaryButtonText: { fontWeight: '600', fontSize: 14 },
  uploadOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(0,0,0,0.4)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  uploadCard: {
    width: '80%',
    padding: Spacing.xl,
    borderRadius: Radius.lg,
    gap: Spacing.sm,
    alignItems: 'center',
    ...Shadow.cardElevated,
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
});
