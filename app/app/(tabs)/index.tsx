import { Image } from 'expo-image';
import * as ImagePicker from 'expo-image-picker';
import { useState } from 'react';
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
import { ApiError } from '@/lib/api';
import { loadConfig } from '@/lib/config';
import { inferContentType, uploadAsset } from '@/lib/upload';

const COLUMNS = 3;
const SPACING = 4;
const TILE = (Dimensions.get('window').width - SPACING * (COLUMNS + 1)) / COLUMNS;

type PickedAsset = ImagePicker.ImagePickerAsset & { id: string };

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

  const [selected, setSelected] = useState<PickedAsset[]>([]);
  const [pickerVisible, setPickerVisible] = useState(false);
  const [uploadState, setUploadState] = useState<UploadState | null>(null);

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
    await uploadAll(prefix);
  }

  async function uploadAll(prefix: string) {
    setUploadState({
      total: selected.length,
      done: 0,
      currentName: '',
      currentBytesSent: 0,
      currentBytesTotal: 0,
    });

    for (let i = 0; i < selected.length; i++) {
      const asset = selected[i]!;
      const filename = filenameFor(asset);
      const contentType = asset.mimeType ?? inferContentType(filename, asset.type ?? 'unknown');
      const key = prefix + filename;

      setUploadState((s) =>
        s ? { ...s, currentName: filename, currentBytesSent: 0, currentBytesTotal: 0 } : s,
      );

      try {
        const isImage = asset.type === 'image' || contentType.startsWith('image/');
        await uploadAsset(asset.uri, key, contentType, isImage, (p) => {
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
          `${filename}: ${message}\n\n${i} of ${selected.length} succeeded before this failure.`,
        );
        return;
      }
    }

    setUploadState(null);
    setSelected([]);
    Alert.alert('Upload complete', `${selected.length} item(s) uploaded to /${prefix}.`);
  }

  return (
    <ThemedView style={styles.container}>
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
});
