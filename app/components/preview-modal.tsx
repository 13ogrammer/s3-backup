import {
  documentDirectory,
  downloadAsync,
  deleteAsync,
} from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import { useVideoPlayer, VideoView } from 'expo-video';
import { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Modal,
  Pressable,
  StyleSheet,
  View,
} from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { ZoomableImage } from '@/components/zoomable-image';
import { Colors } from '@/constants/theme';
import { useColorScheme } from '@/hooks/use-color-scheme';
import { api } from '@/lib/api';
import { basename } from '@/lib/format';

export type PreviewFile = {
  key: string;
  kind: 'image' | 'video' | 'other';
};

type Props = {
  visible: boolean;
  files: PreviewFile[];
  initialIndex: number | null;
  onClose: () => void;
};

export function PreviewModal({ visible, files, initialIndex, onClose }: Props) {
  const colorScheme = useColorScheme() ?? 'light';
  const colors = Colors[colorScheme];
  const insets = useSafeAreaInsets();

  const [index, setIndex] = useState<number>(initialIndex ?? 0);
  const [url, setUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const current = visible && index >= 0 && index < files.length ? files[index] : null;
  const filename = current ? basename(current.key) : '';

  const player = useVideoPlayer(current?.kind === 'video' ? url : null, (p) => {
    p.loop = false;
  });

  useEffect(() => {
    if (visible && initialIndex != null) setIndex(initialIndex);
  }, [visible, initialIndex]);

  useEffect(() => {
    if (!visible || !current) {
      setUrl(null);
      setError(null);
      return;
    }
    setLoading(true);
    setError(null);
    setUrl(null);
    let cancelled = false;
    api
      .signDownload(current.key)
      .then((res) => {
        if (!cancelled) setUrl(res.url);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to sign URL');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [visible, current]);

  async function onDownload() {
    if (!current || !url) return;
    setDownloading(true);
    try {
      const target = `${documentDirectory}${filename}`;
      const dl = await downloadAsync(url, target);
      if (dl.status < 200 || dl.status >= 300) {
        throw new Error(`Download failed: HTTP ${dl.status}`);
      }
      const canShare = await Sharing.isAvailableAsync();
      if (canShare) {
        await Sharing.shareAsync(dl.uri);
      } else {
        Alert.alert('Downloaded', `${filename} saved to app storage.`);
      }
      await deleteAsync(dl.uri, { idempotent: true });
    } catch (err) {
      Alert.alert(
        'Download failed',
        err instanceof Error ? err.message : 'Unknown error',
      );
    } finally {
      setDownloading(false);
    }
  }

  function goPrev() {
    setIndex((i) => Math.max(0, i - 1));
  }

  function goNext() {
    setIndex((i) => Math.min(files.length - 1, i + 1));
  }

  const hasPrev = index > 0;
  const hasNext = index < files.length - 1;

  return (
    <Modal
      visible={visible}
      animationType="fade"
      onRequestClose={onClose}
      transparent
      statusBarTranslucent
      navigationBarTranslucent>
      <GestureHandlerRootView style={{ flex: 1 }}>
        <View style={styles.backdrop}>
          <View style={[styles.header, { paddingTop: insets.top + 12 }]}>
            <Pressable onPress={onClose} hitSlop={12} accessibilityRole="button">
              <ThemedText style={styles.closeText} lightColor="#fff" darkColor="#fff">
                Close
              </ThemedText>
            </Pressable>
            <View style={styles.headerCenter}>
              <ThemedText
                style={styles.filename}
                lightColor="#fff"
                darkColor="#fff"
                numberOfLines={1}>
                {filename}
              </ThemedText>
              {files.length > 1 && (
                <ThemedText
                  style={styles.counter}
                  lightColor="#fff"
                  darkColor="#fff">
                  {index + 1} of {files.length}
                </ThemedText>
              )}
            </View>
            <Pressable
              onPress={onDownload}
              disabled={!url || downloading}
              hitSlop={12}
              accessibilityRole="button">
              <ThemedText
                style={[styles.actionText, { opacity: !url || downloading ? 0.5 : 1 }]}
                lightColor="#fff"
                darkColor="#fff">
                {downloading ? 'Downloading…' : 'Download'}
              </ThemedText>
            </Pressable>
          </View>

          <View style={styles.body}>
            {loading && <ActivityIndicator color="#fff" />}
            {!loading && error && (
              <ThemedText lightColor="#fff" darkColor="#fff" style={{ textAlign: 'center' }}>
                {error}
              </ThemedText>
            )}
            {!loading && !error && url && current?.kind === 'image' && (
              <ZoomableImage uri={url} />
            )}
            {!loading && !error && url && current?.kind === 'video' && (
              <VideoView
                player={player}
                style={styles.media}
                allowsFullscreen
                allowsPictureInPicture
                contentFit="contain"
                nativeControls
              />
            )}
            {!loading && !error && url && current?.kind === 'other' && (
              <ThemedView style={styles.noPreview}>
                <ThemedText type="defaultSemiBold">No preview available</ThemedText>
                <ThemedText style={{ opacity: 0.7, textAlign: 'center' }}>
                  {filename} can't be previewed in the app. Use Save to download it.
                </ThemedText>
              </ThemedView>
            )}
          </View>

          {files.length > 1 && (
            <View style={[styles.navBar, { paddingBottom: Math.max(insets.bottom, 12) + 12 }]}>
              <Pressable
                onPress={goPrev}
                disabled={!hasPrev}
                hitSlop={12}
                style={({ pressed }) => [
                  styles.navButton,
                  {
                    borderColor: hasPrev ? '#fff' : 'rgba(255,255,255,0.3)',
                    opacity: pressed || !hasPrev ? 0.5 : 1,
                  },
                ]}>
                <ThemedText
                  lightColor="#fff"
                  darkColor="#fff"
                  style={[
                    styles.navText,
                    { opacity: hasPrev ? 1 : 0.4 },
                  ]}>
                  ← Prev
                </ThemedText>
              </Pressable>
              <Pressable
                onPress={goNext}
                disabled={!hasNext}
                hitSlop={12}
                style={({ pressed }) => [
                  styles.navButton,
                  {
                    borderColor: hasNext ? '#fff' : 'rgba(255,255,255,0.3)',
                    opacity: pressed || !hasNext ? 0.5 : 1,
                  },
                ]}>
                <ThemedText
                  lightColor="#fff"
                  darkColor="#fff"
                  style={[
                    styles.navText,
                    { opacity: hasNext ? 1 : 0.4 },
                  ]}>
                  Next →
                </ThemedText>
              </Pressable>
            </View>
          )}
        </View>
      </GestureHandlerRootView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.95)',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingBottom: 12,
    gap: 12,
  },
  headerCenter: { flex: 1, alignItems: 'center' },
  filename: { fontWeight: '600' },
  counter: { fontSize: 12, opacity: 0.7, marginTop: 2 },
  closeText: { fontSize: 16 },
  actionText: { fontSize: 16, fontWeight: '600' },
  body: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  media: { width: '100%', height: '100%' },
  noPreview: {
    margin: 24,
    padding: 24,
    borderRadius: 12,
    gap: 8,
    alignItems: 'center',
  },
  navBar: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: 24,
    paddingTop: 12,
    gap: 12,
  },
  navButton: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 8,
    borderWidth: 1,
    alignItems: 'center',
  },
  navText: { fontSize: 15, fontWeight: '600' },
});
