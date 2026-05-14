import {
  documentDirectory,
  downloadAsync,
  deleteAsync,
} from 'expo-file-system/legacy';
import { Image } from 'expo-image';
import * as Sharing from 'expo-sharing';
import { useVideoPlayer, VideoView } from 'expo-video';
import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  Modal,
  Pressable,
  StyleSheet,
  useWindowDimensions,
  View,
} from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { IconSymbol } from '@/components/ui/icon-symbol';
import { ZoomableImage } from '@/components/zoomable-image';
import { Colors, Radius, Spacing } from '@/constants/theme';
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

  const { width: pageWidth, height: windowHeight } = useWindowDimensions();

  const [index, setIndex] = useState<number>(initialIndex ?? 0);
  const [downloading, setDownloading] = useState(false);
  const [urls, setUrls] = useState<Map<string, string>>(new Map());
  const flatListRef = useRef<FlatList<PreviewFile> | null>(null);

  const current = visible && index >= 0 && index < files.length ? files[index] : null;
  const filename = current ? basename(current.key) : '';
  const currentUrl = current ? urls.get(current.key) : undefined;

  useEffect(() => {
    if (visible && initialIndex != null) {
      setIndex(initialIndex);
      // Reset URL cache when reopening for a different list/index.
      setUrls(new Map());
    }
  }, [visible, initialIndex]);

  // Sign URLs for the current page and immediate neighbours; prefetch images.
  useEffect(() => {
    if (!visible) return;
    const wanted = [index - 1, index, index + 1]
      .filter((i) => i >= 0 && i < files.length)
      .map((i) => files[i])
      .filter((f): f is PreviewFile => !!f);
    let cancelled = false;
    for (const f of wanted) {
      if (urls.has(f.key)) continue;
      api
        .signDownload(f.key)
        .then(({ url }) => {
          if (cancelled) return;
          setUrls((prev) => {
            if (prev.has(f.key)) return prev;
            const next = new Map(prev);
            next.set(f.key, url);
            return next;
          });
          if (f.kind === 'image') Image.prefetch(url);
        })
        .catch(() => {});
    }
    return () => {
      cancelled = true;
    };
  }, [visible, index, files, urls]);

  async function onDownload() {
    if (!current || !currentUrl) return;
    setDownloading(true);
    try {
      const target = `${documentDirectory}${filename}`;
      const dl = await downloadAsync(currentUrl, target);
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

  function onMomentumScrollEnd(e: NativeSyntheticEvent<NativeScrollEvent>) {
    const newIndex = Math.round(e.nativeEvent.contentOffset.x / pageWidth);
    if (newIndex !== index) setIndex(newIndex);
  }

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
          <FlatList
            ref={flatListRef}
            style={StyleSheet.absoluteFill}
            data={files}
            keyExtractor={(f) => f.key}
            horizontal
            pagingEnabled
            showsHorizontalScrollIndicator={false}
            initialScrollIndex={initialIndex ?? 0}
            getItemLayout={(_, i) => ({
              length: pageWidth,
              offset: pageWidth * i,
              index: i,
            })}
            onMomentumScrollEnd={onMomentumScrollEnd}
            renderItem={({ item, index: i }) => (
              <PreviewSlide
                file={item}
                url={urls.get(item.key)}
                isActive={i === index}
                width={pageWidth}
                height={windowHeight}
              />
            )}
          />
          <View style={[styles.header, { paddingTop: insets.top + 12 }]}>
            <Pressable
              onPress={onClose}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel="Close preview"
              style={({ pressed }) => [
                styles.headerIconButton,
                styles.headerChipMuted,
                { opacity: pressed ? 0.6 : 1 },
              ]}>
              <IconSymbol name="xmark" size={20} color="#fff" />
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
                <ThemedText style={styles.counter} lightColor="#fff" darkColor="#fff">
                  {index + 1} of {files.length}
                </ThemedText>
              )}
            </View>
            <Pressable
              onPress={onDownload}
              disabled={!currentUrl || downloading}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel="Download"
              style={({ pressed }) => [
                styles.headerIconButton,
                {
                  backgroundColor: colors.tint,
                  opacity: !currentUrl || downloading ? 0.5 : pressed ? 0.7 : 1,
                },
              ]}>
              {downloading ? (
                <ActivityIndicator size="small" color={colors.onAccent} />
              ) : (
                <IconSymbol name="arrow.down.to.line" size={20} color={colors.onAccent} />
              )}
            </Pressable>
          </View>
        </View>
      </GestureHandlerRootView>
    </Modal>
  );
}

type SlideProps = {
  file: PreviewFile;
  url: string | undefined;
  isActive: boolean;
  width: number;
  height: number;
};

function PreviewSlide({ file, url, isActive, width, height }: SlideProps) {
  const filename = basename(file.key);
  const player = useVideoPlayer(file.kind === 'video' ? url ?? null : null, (p) => {
    p.loop = false;
  });

  useEffect(() => {
    if (file.kind !== 'video' || !player) return;
    if (isActive) player.play();
    else player.pause();
  }, [isActive, player, file.kind]);

  return (
    <View style={{ width, height }} pointerEvents={isActive ? 'auto' : 'none'}>
      <View style={styles.slide}>
        {!url && <ActivityIndicator color="#fff" />}
        {url && file.kind === 'image' && <ZoomableImage uri={url} />}
        {url && file.kind === 'video' && (
          <VideoView
            player={player}
            style={styles.media}
            allowsFullscreen
            allowsPictureInPicture
            contentFit="contain"
            nativeControls
          />
        )}
        {url && file.kind === 'other' && (
          <ThemedView style={styles.noPreview}>
            <ThemedText type="defaultSemiBold">No preview available</ThemedText>
            <ThemedText style={{ opacity: 0.7, textAlign: 'center' }}>
              {filename} can't be previewed in the app. Use Download to save it.
            </ThemedText>
          </ThemedView>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.95)',
  },
  header: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.md,
    paddingBottom: Spacing.md,
    gap: Spacing.md,
    zIndex: 10,
    backgroundColor: 'rgba(0,0,0,0.4)',
  },
  headerCenter: { flex: 1, alignItems: 'center' },
  filename: { fontWeight: '600', fontSize: 15 },
  counter: { fontSize: 12, opacity: 0.7, marginTop: 2 },
  headerIconButton: {
    width: 38,
    height: 38,
    borderRadius: Radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerChipMuted: {
    backgroundColor: 'rgba(255,255,255,0.12)',
  },
  slide: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  media: { width: '100%', height: '100%' },
  noPreview: {
    margin: Spacing.xl,
    padding: Spacing.xl,
    borderRadius: Radius.lg,
    gap: Spacing.sm,
    alignItems: 'center',
  },
});
