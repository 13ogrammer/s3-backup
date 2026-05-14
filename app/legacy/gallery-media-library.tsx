// PRESERVED FOR REFERENCE — not registered as a route.
//
// Inline gallery grid using expo-media-library. Requires a custom dev build
// on Android (Expo Go can't run expo-media-library on Android anymore due to
// Google's granular media permissions). To restore this UX after building a
// dev build, replace app/(tabs)/index.tsx with this file's contents.

import { Image } from 'expo-image';
import * as MediaLibrary from 'expo-media-library';
import { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Dimensions,
  FlatList,
  Linking,
  Pressable,
  StyleSheet,
  View,
} from 'react-native';

import { FolderPicker } from '@/components/folder-picker';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Colors } from '@/constants/theme';
import { useColorScheme } from '@/hooks/use-color-scheme';
import { ApiError } from '@/lib/api';
import { loadConfig } from '@/lib/config';
import { inferContentType, uploadFile } from '@/lib/upload';

const COLUMNS = 3;
const SPACING = 2;
const TILE = (Dimensions.get('window').width - SPACING * (COLUMNS + 1)) / COLUMNS;

type UploadState = {
  total: number;
  done: number;
  currentName: string;
  currentBytesSent: number;
  currentBytesTotal: number;
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

  useEffect(() => {
    if (permission?.granted) {
      loadInitial();
    }
  }, [permission?.granted]);

  async function loadInitial() {
    setLoadingAssets(true);
    try {
      const page = await MediaLibrary.getAssetsAsync({
        mediaType: ['photo', 'video'],
        first: 60,
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
        first: 60,
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
    await uploadSelected(prefix);
  }

  async function uploadSelected(prefix: string) {
    const selected = assets.filter((a) => selectedIds.has(a.id));
    if (selected.length === 0) return;

    setUploadState({
      total: selected.length,
      done: 0,
      currentName: '',
      currentBytesSent: 0,
      currentBytesTotal: 0,
    });

    for (let i = 0; i < selected.length; i++) {
      const asset = selected[i]!;
      try {
        const info = await MediaLibrary.getAssetInfoAsync(asset.id);
        const localUri = info.localUri || asset.uri;
        const filename = asset.filename || `media_${asset.id}`;
        const key = prefix + filename;
        const contentType = inferContentType(filename, asset.mediaType);

        setUploadState((s) =>
          s ? { ...s, currentName: filename, currentBytesSent: 0, currentBytesTotal: 0 } : s,
        );

        await uploadFile(localUri, key, contentType, (p) => {
          setUploadState((s) =>
            s
              ? { ...s, currentBytesSent: p.bytesSent, currentBytesTotal: p.bytesTotal }
              : s,
          );
        });

        setUploadState((s) => (s ? { ...s, done: s.done + 1 } : s));
      } catch (err) {
        const message =
          err instanceof ApiError
            ? `(${err.status}) ${err.message}`
            : err instanceof Error
              ? err.message
              : 'Unknown error';
        setUploadState(null);
        Alert.alert(
          'Upload failed',
          `${asset.filename}: ${message}\n\n${i} of ${selected.length} succeeded before this failure.`,
        );
        return;
      }
    }

    setUploadState(null);
    setSelectedIds(new Set());
    Alert.alert('Upload complete', `${selected.length} item(s) uploaded to /${prefix}.`);
  }

  const selectedCount = selectedIds.size;

  const headerRight = useMemo(
    () =>
      selectedCount > 0 ? (
        <Pressable onPress={() => setSelectedIds(new Set())}>
          <ThemedText style={{ color: colors.tint }}>Clear</ThemedText>
        </Pressable>
      ) : null,
    [selectedCount, colors.tint],
  );

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
            <ThemedText lightColor="#fff" darkColor="#000" style={styles.primaryButtonText}>
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
            <ThemedText lightColor="#fff" darkColor="#000" style={styles.primaryButtonText}>
              Open system Settings
            </ThemedText>
          </Pressable>
        )}
      </ThemedView>
    );
  }

  return (
    <ThemedView style={styles.container}>
      <FlatList
        data={assets}
        keyExtractor={(item) => item.id}
        numColumns={COLUMNS}
        contentContainerStyle={{ padding: SPACING }}
        columnWrapperStyle={{ gap: SPACING, marginBottom: SPACING }}
        onEndReached={loadMore}
        onEndReachedThreshold={0.5}
        ListFooterComponent={
          loadingAssets && hasMore ? (
            <View style={{ padding: 16 }}>
              <ActivityIndicator />
            </View>
          ) : null
        }
        renderItem={({ item }) => {
          const selected = selectedIds.has(item.id);
          return (
            <Pressable
              onPress={() => toggle(item.id)}
              style={{ width: TILE, height: TILE }}>
              <Image
                source={{ uri: item.uri }}
                style={{ width: TILE, height: TILE, borderRadius: 4 }}
                contentFit="cover"
                recyclingKey={item.id}
              />
              {item.mediaType === 'video' && (
                <View style={styles.videoBadge}>
                  <ThemedText style={styles.videoBadgeText}>VIDEO</ThemedText>
                </View>
              )}
              {selected && (
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
          );
        }}
      />

      {selectedCount > 0 && (
        <View style={[styles.bottomBar, { backgroundColor: colors.background, borderColor: colors.icon }]}>
          <View style={{ flex: 1 }}>
            <ThemedText type="defaultSemiBold">
              {selectedCount} selected
            </ThemedText>
            <Pressable onPress={() => setSelectedIds(new Set())}>
              <ThemedText style={{ color: colors.tint, fontSize: 13 }}>Clear</ThemedText>
            </Pressable>
          </View>
          <Pressable
            onPress={onTapUpload}
            style={({ pressed }) => [
              styles.primaryButton,
              { backgroundColor: colors.tint, opacity: pressed ? 0.7 : 1 },
            ]}>
            <ThemedText lightColor="#fff" darkColor="#000" style={styles.primaryButtonText}>
              Upload…
            </ThemedText>
          </Pressable>
        </View>
      )}

      <FolderPicker
        visible={pickerVisible}
        onClose={() => setPickerVisible(false)}
        onPick={onPickFolder}
      />

      {uploadState && (
        <View style={styles.uploadOverlay}>
          <ThemedView style={styles.uploadCard}>
            <ActivityIndicator />
            <ThemedText type="defaultSemiBold">
              Uploading {uploadState.done + 1} of {uploadState.total}
            </ThemedText>
            <ThemedText style={{ opacity: 0.7 }} numberOfLines={1}>
              {uploadState.currentName}
            </ThemedText>
            {uploadState.currentBytesTotal > 0 && (
              <View style={styles.progressBarBg}>
                <View
                  style={[
                    styles.progressBarFill,
                    {
                      backgroundColor: colors.tint,
                      width: `${Math.min(
                        100,
                        Math.round(
                          (uploadState.currentBytesSent / uploadState.currentBytesTotal) * 100,
                        ),
                      )}%`,
                    },
                  ]}
                />
              </View>
            )}
          </ThemedView>
        </View>
      )}
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  center: { alignItems: 'center', justifyContent: 'center' },
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
  bottomBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 28,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  primaryButton: {
    paddingHorizontal: 20,
    paddingVertical: 12,
    borderRadius: 8,
  },
  primaryButtonText: { fontWeight: '600' },
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
    padding: 20,
    borderRadius: 12,
    gap: 8,
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
});
