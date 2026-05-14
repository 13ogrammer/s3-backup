import { getInfoAsync } from 'expo-file-system/legacy';
import { Image } from 'expo-image';
import * as ImagePicker from 'expo-image-picker';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Dimensions,
  FlatList,
  Pressable,
  StyleSheet,
  View,
} from 'react-native';

import { FolderPicker } from '@/components/folder-picker';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Colors, Radius, Shadow, Spacing } from '@/constants/theme';
import { useColorScheme } from '@/hooks/use-color-scheme';
import { api, ApiError } from '@/lib/api';
import { getLastFolder, loadConfig, setLastFolder } from '@/lib/config';
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
import { formatBytes } from '@/lib/format';

const UPLOAD_CONCURRENCY = 3;

const COLUMNS = 3;
const SPACING = 4;
const TILE = (Dimensions.get('window').width - SPACING * (COLUMNS + 1)) / COLUMNS;

type PickedAsset = ImagePicker.ImagePickerAsset & { id: string };

type UploadState = {
  total: number;
  done: number;
  failed: number;
  inFlight: string[];
};

export default function GalleryScreen() {
  const colorScheme = useColorScheme() ?? 'light';
  const colors = Colors[colorScheme];

  const [selected, setSelected] = useState<PickedAsset[]>([]);
  const [pickerVisible, setPickerVisible] = useState(false);
  const [uploadState, setUploadState] = useState<UploadState | null>(null);
  const [lastFolder, setLastFolderState] = useState<string | undefined>(undefined);
  const [pendingResume, setPendingResume] = useState<PendingMultipartUpload[]>([]);

  useEffect(() => {
    getLastFolder().then((f) => {
      if (f != null) setLastFolderState(f);
    });
  }, []);

  useEffect(() => {
    refreshPendingResume();
  }, []);

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

  // Hold the screen awake while an upload is running. Uploads pause when
  // the app is backgrounded (RN suspends JS), so the simplest useful
  // mitigation is to stop the screen from going to sleep at all.
  const uploading = uploadState !== null;
  useEffect(() => {
    if (!uploading) return;
    activateKeepAwakeAsync('s3backup.upload').catch(() => {});
    return () => {
      deactivateKeepAwake('s3backup.upload');
    };
  }, [uploading]);

  async function onAddPhotos() {
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images', 'videos'],
      allowsMultipleSelection: true,
      quality: 1,
      exif: false,
    });
    if (result.canceled) return;

    const stamped: PickedAsset[] = result.assets.map((a, i) => ({
      ...a,
      id: a.assetId ?? `${a.uri}-${Date.now()}-${i}`,
    }));

    setSelected((prev) => {
      const seen = new Set(prev.map((p) => p.uri));
      const additions = stamped.filter((s) => !seen.has(s.uri));
      return [...prev, ...additions];
    });
  }

  function removeAsset(id: string) {
    setSelected((prev) => prev.filter((p) => p.id !== id));
  }

  function clearAll() {
    setSelected([]);
  }

  async function onTapUpload() {
    if (selected.length === 0) return;
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
    await uploadAll(prefix);
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

  async function uploadAll(prefix: string) {
    // Pre-flight: ask the backend which destination keys already exist.
    const plan = selected.map((asset) => ({
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
        // 'overwrite' falls through with toUpload unchanged.
      }
    } catch (err) {
      // Pre-flight failure is non-fatal — proceed with the upload, which
      // will either succeed (overwrite) or surface its own error.
      console.warn('pre-flight /exists failed', err);
    }

    setUploadState({
      total: toUpload.length,
      done: 0,
      failed: 0,
      inFlight: [],
    });

    const failed = await runWithConcurrency(
      toUpload.map((p) => p.asset),
      async (asset) => {
        const filename = filenameFor(asset);
        const contentType =
          asset.mimeType ?? inferContentType(filename, asset.type ?? 'unknown');
        const key = prefix + filename;
        const mediaKind: 'image' | 'video' | 'other' =
          asset.type === 'image' || contentType.startsWith('image/')
            ? 'image'
            : asset.type === 'video' || contentType.startsWith('video/')
              ? 'video'
              : 'other';

        setUploadState((s) =>
          s ? { ...s, inFlight: [...s.inFlight, filename] } : s,
        );
        try {
          await uploadAsset(asset.uri, key, contentType, mediaKind);
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

    // Aggregate counts after the run completes.
    setUploadState(null);

    if (failed.length === 0) {
      setSelected([]);
      Alert.alert('Upload complete', `${toUpload.length} item(s) uploaded to /${prefix}.`);
      return;
    }

    // Surface failures and leave the failed items selected so the user
    // can retry.
    const failedFilenames = new Set(failed.map(({ item }) => filenameFor(item)));
    const succeeded = toUpload.length - failed.length;
    setSelected((prev) => prev.filter((a) => failedFilenames.has(filenameFor(a))));
    const sample = failed
      .slice(0, 3)
      .map(({ item, error }) => {
        const msg = describeError(error);
        return `• ${filenameFor(item)}: ${msg}`;
      })
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

  const pendingBytesRemaining = pendingResume.reduce((sum, e) => {
    const done = e.completedParts.reduce((b, p) => {
      const offset = (p.partNumber - 1) * e.partSize;
      return b + Math.min(e.partSize, Math.max(0, e.totalBytes - offset));
    }, 0);
    return sum + Math.max(0, e.totalBytes - done);
  }, 0);

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
      {selected.length === 0 ? (
        <View style={styles.emptyState}>
          <ThemedText type="title">No items picked</ThemedText>
          <ThemedText style={styles.hint}>
            Tap below to choose photos and videos to back up.
          </ThemedText>
          <Pressable
            onPress={onAddPhotos}
            style={({ pressed }) => [
              styles.primaryButton,
              { backgroundColor: colors.tint, opacity: pressed ? 0.7 : 1 },
            ]}>
            <ThemedText style={[styles.primaryButtonText, { color: colors.onAccent }]}>
              Add photos / videos
            </ThemedText>
          </Pressable>
        </View>
      ) : (
        <FlatList
          data={selected}
          keyExtractor={(item) => item.id}
          numColumns={COLUMNS}
          contentContainerStyle={{ padding: SPACING }}
          columnWrapperStyle={{ gap: SPACING, marginBottom: SPACING }}
          ListHeaderComponent={
            <View style={styles.headerRow}>
              <Pressable
                onPress={onAddPhotos}
                style={({ pressed }) => [
                  styles.chip,
                  { backgroundColor: colors.accentSoft, opacity: pressed ? 0.7 : 1 },
                ]}>
                <ThemedText style={{ color: colors.tint, fontWeight: '600' }}>
                  + Add more
                </ThemedText>
              </Pressable>
              <Pressable
                onPress={clearAll}
                style={({ pressed }) => [
                  styles.chip,
                  { backgroundColor: colors.surfaceMuted, opacity: pressed ? 0.7 : 1 },
                ]}>
                <ThemedText>Clear</ThemedText>
              </Pressable>
            </View>
          }
          renderItem={({ item }) => (
            <View style={{ width: TILE, height: TILE }}>
              <Image
                source={{ uri: item.uri }}
                style={{ width: TILE, height: TILE, borderRadius: 4 }}
                contentFit="cover"
                recyclingKey={item.id}
              />
              {item.type === 'video' && (
                <View style={styles.videoBadge}>
                  <ThemedText style={styles.videoBadgeText}>VIDEO</ThemedText>
                </View>
              )}
              <Pressable
                onPress={() => removeAsset(item.id)}
                hitSlop={8}
                style={styles.removeButton}>
                <ThemedText style={styles.removeButtonText}>✕</ThemedText>
              </Pressable>
            </View>
          )}
        />
      )}

      {selected.length > 0 && (
        <View style={[styles.bottomBar, { backgroundColor: colors.background, borderColor: colors.icon }]}>
          <ThemedText type="defaultSemiBold" style={{ flex: 1 }}>
            {selected.length} ready to upload
          </ThemedText>
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

function filenameFor(asset: ImagePicker.ImagePickerAsset): string {
  if (asset.fileName) return asset.fileName;
  const fromUri = asset.uri.split('/').pop()?.split('?')[0];
  if (fromUri && fromUri.includes('.')) return fromUri;
  const ext = extFromMime(asset.mimeType) ?? (asset.type === 'video' ? 'mp4' : 'jpg');
  return `media_${Date.now()}.${ext}`;
}

function extFromMime(mime: string | undefined): string | undefined {
  if (!mime) return undefined;
  const map: Record<string, string> = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/heic': 'heic',
    'image/heif': 'heif',
    'image/webp': 'webp',
    'image/gif': 'gif',
    'video/mp4': 'mp4',
    'video/quicktime': 'mov',
    'video/x-matroska': 'mkv',
  };
  return map[mime];
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  emptyState: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.lg,
    padding: Spacing.xl,
  },
  hint: { textAlign: 'center', opacity: 0.7 },
  headerRow: {
    flexDirection: 'row',
    gap: Spacing.sm,
    paddingHorizontal: SPACING * 2,
    paddingBottom: SPACING * 2,
    paddingTop: Spacing.md,
  },
  chip: {
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm,
    borderRadius: Radius.md,
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
  removeButton: {
    position: 'absolute',
    top: 4,
    right: 4,
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: 'rgba(0,0,0,0.65)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  removeButtonText: { color: '#fff', fontWeight: '700', fontSize: 12 },
  bottomBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
    paddingHorizontal: Spacing.lg,
    paddingTop: Spacing.md,
    paddingBottom: Spacing.xl + 8,
    ...Shadow.cardElevated,
  },
  primaryButton: {
    paddingHorizontal: Spacing.xl,
    paddingVertical: 14,
    borderRadius: Radius.md,
  },
  primaryButtonText: { fontWeight: '600', fontSize: 15 },
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
