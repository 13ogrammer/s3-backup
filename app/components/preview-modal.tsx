// PreviewModal is intentionally full-screen (statusBarTranslucent +
// navigationBarTranslucent with safe-area padding) and does NOT use the
// ModalCard shell. S3B-41 scoped ModalCard to card-style overlays only.
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
  Platform,
  Pressable,
  StyleSheet,
  useWindowDimensions,
  View,
} from 'react-native';
import { Gesture, GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler';
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { MetadataPanel, type HeadEntry } from '@/components/metadata-panel';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { IconSymbol } from '@/components/ui/icon-symbol';
import { ZoomableImage } from '@/components/zoomable-image';
import { Colors, Radius, Spacing } from '@/constants/theme';
import { useColorScheme } from '@/hooks/use-color-scheme';
import { api, type GetDerivedUrlResponse, type HeadResponse } from '@/lib/api';
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

// The panel occupies roughly 60% of the slide height when open.
const PANEL_OPEN_FRACTION = 0.60;
// Swipe threshold to trigger open/close (px).
const SWIPE_THRESHOLD = 50;

export function PreviewModal({ visible, files, initialIndex, onClose }: Props) {
  const colorScheme = useColorScheme() ?? 'light';
  const colors = Colors[colorScheme];
  const insets = useSafeAreaInsets();

  const { width: pageWidth, height: windowHeight } = useWindowDimensions();

  const [index, setIndex] = useState<number>(initialIndex ?? 0);
  const [downloading, setDownloading] = useState(false);
  // Dual-URL shape: previewUrl is the /get-derived-url preview tier for images
  // (1920px JPEG); originalUrl is the signed download URL used for video
  // playback and the Download button.
  const [urls, setUrls] = useState<Map<string, { previewUrl?: string; originalUrl?: string }>>(new Map());
  const [isZoomed, setIsZoomed] = useState(false);
  const flatListRef = useRef<FlatList<PreviewFile> | null>(null);

  // Session-scoped cache for /head responses. Cleared alongside urls on reopen.
  const [headCache, setHeadCache] = useState<Map<string, HeadEntry>>(new Map());

  const current = visible && index >= 0 && index < files.length ? files[index] : null;
  const filename = current ? basename(current.key) : '';
  const currentEntry = current ? urls.get(current.key) : undefined;
  // Download always uses the original signed URL.
  const currentDownloadUrl = currentEntry?.originalUrl;
  // Display URL: for images prefer the preview tier; fall back to original if
  // preview isn't ready yet (should not happen normally).
  const currentDisplayUrl =
    current?.kind === 'image'
      ? currentEntry?.previewUrl ?? currentEntry?.originalUrl
      : currentEntry?.originalUrl;

  useEffect(() => {
    if (visible && initialIndex != null) {
      setIndex(initialIndex);
      // Reset URL cache and head cache when reopening for a different list/index.
      setUrls(new Map<string, { previewUrl?: string; originalUrl?: string }>());
      setHeadCache(new Map<string, HeadEntry>());
      setIsZoomed(false);
    }
  }, [visible, initialIndex]);

  // Fetch URLs for the current page and immediate neighbours; prefetch images.
  //
  // Images: fetch a preview-tier URL via /get-derived-url (1920px JPEG) for
  // display, plus an originalUrl via /sign-download for the Download button.
  // Videos and other kinds: only /sign-download (original) is needed.
  useEffect(() => {
    if (!visible) return;
    const wanted = [index - 1, index, index + 1]
      .filter((i) => i >= 0 && i < files.length)
      .map((i) => files[i])
      .filter((f): f is PreviewFile => !!f);
    let cancelled = false;
    for (const f of wanted) {
      const existing = urls.get(f.key);

      if (f.kind === 'image') {
        // For images we need both a preview URL and an original URL.
        if (!existing?.previewUrl) {
          api
            .getDerivedUrl(f.key, 'preview')
            .then((res) => {
              if (cancelled) return;
              const url = (res as { url: string | null }).url !== null
                ? (res as GetDerivedUrlResponse).url
                : undefined;
              if (!url) return;
              setUrls((prev) => {
                const entry = prev.get(f.key) ?? {};
                if (entry.previewUrl) return prev;
                const next = new Map(prev);
                next.set(f.key, { ...entry, previewUrl: url });
                return next;
              });
              Image.prefetch(url);
            })
            .catch(() => {});
        }
        if (!existing?.originalUrl) {
          api
            .signDownload(f.key)
            .then(({ url }) => {
              if (cancelled) return;
              setUrls((prev) => {
                const entry = prev.get(f.key) ?? {};
                if (entry.originalUrl) return prev;
                const next = new Map(prev);
                next.set(f.key, { ...entry, originalUrl: url });
                return next;
              });
            })
            .catch(() => {});
        }
      } else {
        // Videos and other kinds: original URL is the only URL needed.
        if (!existing?.originalUrl) {
          api
            .signDownload(f.key)
            .then(({ url }) => {
              if (cancelled) return;
              setUrls((prev) => {
                const entry = prev.get(f.key) ?? {};
                if (entry.originalUrl) return prev;
                const next = new Map(prev);
                next.set(f.key, { ...entry, originalUrl: url });
                return next;
              });
            })
            .catch(() => {});
        }
      }
    }
    return () => {
      cancelled = true;
    };
  }, [visible, index, files, urls]);

  // Lazy-fetch /head for the active image slide. One fetch per key per session.
  useEffect(() => {
    if (!visible || !current || current.kind !== 'image') return;
    const key = current.key;
    if (headCache.has(key)) return;

    // Mark loading immediately so the panel shows a spinner on first open.
    setHeadCache((prev) => {
      if (prev.has(key)) return prev;
      const next = new Map(prev);
      next.set(key, { status: 'loading' });
      return next;
    });

    let cancelled = false;
    api
      .head(key)
      .then((data: HeadResponse) => {
        if (cancelled) return;
        setHeadCache((prev) => {
          const next = new Map(prev);
          next.set(key, { status: 'ok', data });
          return next;
        });
      })
      .catch(() => {
        if (cancelled) return;
        setHeadCache((prev) => {
          const next = new Map(prev);
          next.set(key, { status: 'unavailable' });
          return next;
        });
      });

    return () => {
      cancelled = true;
    };
    // headCache intentionally omitted — we want to re-run only when key changes,
    // not whenever the cache map reference changes after a set.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, current?.key]);

  async function onDownload() {
    if (!current || !currentDownloadUrl) return;
    const currentUrl = currentDownloadUrl;
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
            scrollEnabled={!isZoomed}
            showsHorizontalScrollIndicator={false}
            initialScrollIndex={initialIndex ?? 0}
            getItemLayout={(_, i) => ({
              length: pageWidth,
              offset: pageWidth * i,
              index: i,
            })}
            onMomentumScrollEnd={onMomentumScrollEnd}
            renderItem={({ item, index: i }) => {
              const entry = urls.get(item.key);
              const displayUrl =
                item.kind === 'image'
                  ? entry?.previewUrl ?? entry?.originalUrl
                  : entry?.originalUrl;
              return (
                <PreviewSlide
                  file={item}
                  displayUrl={displayUrl}
                  originalUrl={entry?.originalUrl}
                  isActive={i === index}
                  isZoomed={i === index ? isZoomed : false}
                  width={pageWidth}
                  height={windowHeight}
                  bottomInset={Platform.OS === 'android' ? insets.bottom : 0}
                  safeBottomInset={insets.bottom}
                  onZoomChange={i === index ? setIsZoomed : undefined}
                  headEntry={headCache.get(item.key)}
                />
              );
            }}
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
              disabled={!currentDownloadUrl || downloading}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel="Download"
              style={({ pressed }) => [
                styles.headerIconButton,
                {
                  backgroundColor: colors.tint,
                  opacity: !currentDownloadUrl || downloading ? 0.5 : pressed ? 0.7 : 1,
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
  /** URL for display: preview-tier JPEG for images, original for video/other. */
  displayUrl: string | undefined;
  /** Original signed URL — used for video player and (externally) for download. */
  originalUrl: string | undefined;
  isActive: boolean;
  isZoomed: boolean;
  width: number;
  height: number;
  /** Android bottom inset for the video player bar. */
  bottomInset: number;
  /** Safe-area bottom inset passed into the metadata panel. */
  safeBottomInset: number;
  onZoomChange?: (zoomed: boolean) => void;
  headEntry: HeadEntry | undefined;
};

function PreviewSlide({
  file,
  displayUrl,
  originalUrl,
  isActive,
  isZoomed,
  width,
  height,
  bottomInset,
  safeBottomInset,
  onZoomChange,
  headEntry,
}: SlideProps) {
  const filename = basename(file.key);
  const panelHeight = height * PANEL_OPEN_FRACTION;

  // translateY: 0 = hidden (fully off-screen at bottom), -panelHeight = fully shown.
  const translateY = useSharedValue(0);
  const [panelOpen, setPanelOpen] = useState(false);

  // Reset panel to hidden whenever this slide loses focus.
  useEffect(() => {
    if (!isActive) {
      translateY.value = withTiming(0, { duration: 250 });
      runOnJS(setPanelOpen)(false);
    }
  }, [isActive, translateY]);

  function openPanel() {
    translateY.value = withTiming(-panelHeight, { duration: 300 });
    setPanelOpen(true);
  }

  function closePanel() {
    translateY.value = withTiming(0, { duration: 250 });
    setPanelOpen(false);
  }

  // Vertical pan gesture: enabled only on active, non-zoomed image slides.
  const panGesture = Gesture.Pan()
    .enabled(isActive && !isZoomed && file.kind === 'image')
    // Only activate on clearly vertical drags, so horizontal paging is unaffected.
    .activeOffsetY([-15, 15])
    .failOffsetX([-20, 20])
    .onEnd((e) => {
      'worklet';
      if (e.translationY < -SWIPE_THRESHOLD) {
        // Swipe up — open panel.
        runOnJS(openPanel)();
      } else if (e.translationY > SWIPE_THRESHOLD) {
        // Swipe down — close panel.
        runOnJS(closePanel)();
      }
    });

  const panelStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: translateY.value }],
  }));

  return (
    <GestureDetector gesture={panGesture}>
      <View style={{ width, height }} pointerEvents={isActive ? 'auto' : 'none'}>
        <View style={styles.slide}>
          {!displayUrl && <ActivityIndicator color="#fff" />}
          {displayUrl && file.kind === 'image' && (
            <ZoomableImage uri={displayUrl} onZoomChange={onZoomChange} />
          )}
          {file.kind === 'video' && originalUrl && (
            <VideoSlide uri={originalUrl} isActive={isActive} bottomInset={bottomInset} />
          )}
          {displayUrl && file.kind === 'other' && (
            <ThemedView style={styles.noPreview}>
              <ThemedText type="defaultSemiBold">No preview available</ThemedText>
              <ThemedText style={{ opacity: 0.7, textAlign: 'center' }}>
                {filename} can't be previewed in the app. Use Download to save it.
              </ThemedText>
            </ThemedView>
          )}
        </View>

        {/* Metadata panel — image slides only, bottom-anchored */}
        {file.kind === 'image' && (
          <Animated.View
            style={[
              styles.panelContainer,
              { height: panelHeight },
              panelStyle,
            ]}
            pointerEvents={panelOpen ? 'auto' : 'none'}>
            <MetadataPanel
              fileKey={file.key}
              entry={headEntry}
              bottomInset={safeBottomInset}
            />
          </Animated.View>
        )}
      </View>
    </GestureDetector>
  );
}

function VideoSlide({ uri, isActive, bottomInset }: { uri: string; isActive: boolean; bottomInset: number }) {
  const player = useVideoPlayer(uri, (p) => {
    p.loop = false;
  });

  useEffect(() => {
    if (!player) return;
    if (isActive) player.play();
    else player.pause();
  }, [isActive, player]);

  return (
    <View style={{ width: '100%', flex: 1, paddingBottom: bottomInset }}>
      <VideoView
        player={player}
        style={styles.media}
        fullscreenOptions={{ enable: true }}
        allowsPictureInPicture
        contentFit="contain"
        nativeControls
      />
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
  panelContainer: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    // Panel starts off-screen below its container; translateY animates it up.
    transform: [{ translateY: 0 }],
  },
});
