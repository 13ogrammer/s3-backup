// PreviewModal is intentionally full-screen (statusBarTranslucent +
// navigationBarTranslucent with safe-area padding) and does NOT use the
// ModalCard shell. S3B-41 scoped ModalCard to card-style overlays only.
import {
  createDownloadResumable,
  deleteAsync,
  documentDirectory,
  downloadAsync,
  type DownloadResumable,
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
  type SharedValue,
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
import { Colors, Radius, Shadow, Spacing, Type } from '@/constants/theme';
import { useColorScheme } from '@/hooks/use-color-scheme';
import { api, type HeadResponse } from '@/lib/api';
import { basename } from '@/lib/format';
import { useJobs } from '@/lib/jobs';

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

// Details panel is a fixed fraction of the screen height when open.
const PANEL_OPEN_FRACTION = 0.5;
// Swipe threshold to trigger open/close (px).
const SWIPE_THRESHOLD = 50;

// Videos at or above this byte size are gated: stream is blocked and the user
// must explicitly download to local storage before playback. Avoids stalls on
// large files over flaky cellular connections.
const LARGE_VIDEO_THRESHOLD_BYTES = 150 * 1024 * 1024;

// Buffer tuning applied to every VideoPlayer instance. Values are materially
// larger than defaults (iOS default: 0 s forward buffer; Android default: 20 s).
// waitsToMinimizeStalling is iOS-only; prioritizeTimeOverSizeThreshold is
// Android-only — expo-video ignores fields that don't apply to the platform.
const VIDEO_BUFFER_OPTIONS = {
  preferredForwardBufferDuration: 60,
  waitsToMinimizeStalling: true,
  minBufferForPlayback: 5,
  prioritizeTimeOverSizeThreshold: true,
} as const;

export function PreviewModal({ visible, files, initialIndex, onClose }: Props) {
  const colorScheme = useColorScheme() ?? 'light';
  const colors = Colors[colorScheme];
  const insets = useSafeAreaInsets();
  const { addJob, allJobs } = useJobs();

  const { width: pageWidth, height: windowHeight } = useWindowDimensions();
  const panelHeight = Math.round(windowHeight * PANEL_OPEN_FRACTION);

  const [index, setIndex] = useState<number>(initialIndex ?? 0);
  const [downloading, setDownloading] = useState(false);
  // Dual-URL shape: previewUrl is the /get-derived-url preview tier for images
  // (1920px JPEG); originalUrl is the signed download URL used for video
  // playback and the Download button. For videos, previewUrl is the low-bitrate
  // MP4 preview once generated; nil while pending.
  const [urls, setUrls] = useState<Map<string, { previewUrl?: string; originalUrl?: string }>>(new Map());
  // Tracks in-flight transcode job IDs keyed by video key. Cleared on preview URL arrival.
  const [pendingTranscodeJobs, setPendingTranscodeJobs] = useState<Map<string, string>>(new Map());
  const [isZoomed, setIsZoomed] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [panelOpen, setPanelOpen] = useState(false);
  const flatListRef = useRef<FlatList<PreviewFile> | null>(null);

  // Session-scoped cache for /head responses. Cleared alongside urls on reopen.
  const [headCache, setHeadCache] = useState<Map<string, HeadEntry>>(new Map());

  // Local file URIs for large videos that the user has downloaded this session.
  // Keyed by the S3 key. Cleared on modal close / reopen so temp files are deleted.
  const [localVideoUris, setLocalVideoUris] = useState<Map<string, string>>(new Map());

  // Per-key download-trigger counters. Bumped by the "Play offline" menu item to
  // instruct the active LargeVideoPrompt to kick off a download even when the CTA
  // was never tapped directly.
  const [triggerDownloadCounters, setTriggerDownloadCounters] = useState<Map<string, number>>(new Map());

  // 0 = closed (panel below screen, slides at natural position), 1 = open.
  const panelProgress = useSharedValue(0);

  const current = visible && index >= 0 && index < files.length ? files[index] : null;
  const filename = current ? basename(current.key) : '';
  const currentEntry = current ? urls.get(current.key) : undefined;
  // Download always uses the original signed URL.
  const currentDownloadUrl = currentEntry?.originalUrl;

  // Derive size-gate info for the current slide so the menu can decide whether
  // to show "Play offline".
  const currentHeadEntry = current ? headCache.get(current.key) : undefined;
  const currentSizeBytes =
    currentHeadEntry?.status === 'ok' ? currentHeadEntry.data.sizeBytes : undefined;
  const currentPreviewUrl = currentEntry?.previewUrl;
  const isCurrentSlideOfflineEligible =
    current?.kind === 'video' &&
    currentHeadEntry?.status === 'ok' &&
    currentPreviewUrl == null &&
    currentSizeBytes != null &&
    currentSizeBytes >= LARGE_VIDEO_THRESHOLD_BYTES;

  function openPanel() {
    panelProgress.value = withTiming(1, { duration: 300 });
    setPanelOpen(true);
  }
  function closePanel() {
    panelProgress.value = withTiming(0, { duration: 250 });
    setPanelOpen(false);
  }

  // Cleanup: delete all session-local video files and clear the map.
  async function clearLocalVideoUris(map: Map<string, string>) {
    for (const uri of map.values()) {
      await deleteAsync(uri, { idempotent: true }).catch(() => {});
    }
  }

  useEffect(() => {
    if (visible && initialIndex != null) {
      setIndex(initialIndex);
      // Reset URL cache and head cache when reopening for a different list/index.
      setUrls(new Map<string, { previewUrl?: string; originalUrl?: string }>());
      setPendingTranscodeJobs(new Map<string, string>());
      setHeadCache(new Map<string, HeadEntry>());
      setIsZoomed(false);
      setMenuOpen(false);
      setPanelOpen(false);
      panelProgress.value = 0;
      // Clear any locally-downloaded video files from the previous session.
      setLocalVideoUris((prev) => {
        clearLocalVideoUris(prev);
        return new Map<string, string>();
      });
      setTriggerDownloadCounters(new Map<string, number>());
    }
  }, [visible, initialIndex, panelProgress]);

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
              // Narrow: image preview returns synchronous URL (not pending).
              if ('status' in res || !('url' in res) || !res.url) return;
              const url = res.url;
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
      } else if (f.kind === 'video') {
        // Video: fetch original URL for playback fallback + try to get a preview.
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
        // Request the low-bitrate preview MP4. If already generated, use it.
        // If generating, register the job so the strip shows progress and we
        // hot-swap when done (handled by the job-completion watcher below).
        if (!existing?.previewUrl && !pendingTranscodeJobs.has(f.key)) {
          api
            .getDerivedUrl(f.key, 'preview')
            .then((res) => {
              if (cancelled) return;
              if ('status' in res && res.status === 'pending') {
                // Transcode job enqueued — register it so JobsStrip shows progress.
                const key = f.key;
                const jobId = res.jobId;
                setPendingTranscodeJobs((prev) => {
                  if (prev.has(key)) return prev;
                  const next = new Map(prev);
                  next.set(key, jobId);
                  return next;
                });
                addJob(jobId, { kind: 'video-transcode', key }).catch(() => {});
              } else if ('url' in res && res.url) {
                // Preview already existed — use it immediately.
                const url = res.url;
                setUrls((prev) => {
                  const entry = prev.get(f.key) ?? {};
                  if (entry.previewUrl) return prev;
                  const next = new Map(prev);
                  next.set(f.key, { ...entry, previewUrl: url });
                  return next;
                });
              }
            })
            .catch(() => {});
        }
      } else {
        // Other kinds: original URL is the only URL needed.
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
    // pendingTranscodeJobs intentionally omitted — we only want to trigger on
    // index/file changes, not every time a job is registered.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, index, files, urls]);

  // Watch pending transcode jobs. When one completes, re-fetch the preview URL
  // and hot-swap it into the video slide without requiring a modal close.
  useEffect(() => {
    if (pendingTranscodeJobs.size === 0) return;
    for (const [key, jobId] of pendingTranscodeJobs) {
      const record = allJobs.find((j) => j.jobId === jobId);
      if (!record || record.status !== 'completed') continue;
      // Job finished — fetch the preview URL and clear the pending entry.
      setPendingTranscodeJobs((prev) => {
        const next = new Map(prev);
        next.delete(key);
        return next;
      });
      api
        .getDerivedUrl(key, 'preview')
        .then((res) => {
          if ('url' in res && res.url) {
            const url = res.url;
            setUrls((prev) => {
              const entry = prev.get(key) ?? {};
              const next = new Map(prev);
              next.set(key, { ...entry, previewUrl: url });
              return next;
            });
          }
        })
        .catch(() => {});
    }
  }, [allJobs, pendingTranscodeJobs]);

  // Lazy-fetch /head for the active slide (any kind). One fetch per key per session.
  // For non-images, /head still returns size + lastModified — useful in the details
  // panel even when no EXIF metadata is present.
  useEffect(() => {
    if (!visible || !current) return;
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
    if (newIndex !== index) {
      setIndex(newIndex);
      // Panel intentionally stays open — its content updates for the new file.
      if (menuOpen) setMenuOpen(false);
    }
  }

  // Panel slides up from below by exactly its fixed height. translateY-only ⇒
  // no layout per frame ⇒ no expo-image flicker.
  const panelOuterStyle = useAnimatedStyle(
    () => ({
      transform: [{ translateY: panelHeight * (1 - panelProgress.value) }],
    }),
    [panelHeight],
  );

  function handleMenuDetails() {
    setMenuOpen(false);
    if (!panelOpen) openPanel();
  }
  function handleMenuDownload() {
    setMenuOpen(false);
    onDownload();
  }
  function handleMenuPlayOffline() {
    if (!current) return;
    setMenuOpen(false);
    // Idempotent: only bump if no download is already in flight for this key.
    // LargeVideoPrompt will pick up the counter increment and start downloading.
    setTriggerDownloadCounters((prev) => {
      const next = new Map(prev);
      next.set(current.key, (prev.get(current.key) ?? 0) + 1);
      return next;
    });
  }

  function handlePlayLocal(key: string, localUri: string) {
    setLocalVideoUris((prev) => {
      const next = new Map(prev);
      next.set(key, localUri);
      return next;
    });
  }

  // Clean up all locally-downloaded video files when the modal closes.
  function handleClose() {
    setLocalVideoUris((prev) => {
      clearLocalVideoUris(prev);
      return new Map<string, string>();
    });
    onClose();
  }

  return (
    <Modal
      visible={visible}
      animationType="fade"
      onRequestClose={handleClose}
      transparent
      statusBarTranslucent
      navigationBarTranslucent>
      <GestureHandlerRootView style={{ flex: 1 }}>
        <View style={styles.backdrop}>
          {/* Content area: image / video pager. Slides translate per-kind so the
              visible media stays above the open details panel. */}
          <View style={styles.contentArea}>
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
                // For videos: use preview MP4 when ready, fall back to original.
                const videoDisplayUrl = entry?.previewUrl ?? entry?.originalUrl;
                const displayUrl =
                  item.kind === 'image'
                    ? entry?.previewUrl ?? entry?.originalUrl
                    : item.kind === 'video'
                    ? videoDisplayUrl
                    : entry?.originalUrl;
                const itemHead = headCache.get(item.key);
                const itemSizeBytes =
                  itemHead?.status === 'ok' ? itemHead.data.sizeBytes : undefined;
                const itemLocalUri = localVideoUris.get(item.key);
                const itemTriggerDownload = triggerDownloadCounters.get(item.key) ?? 0;
                return (
                  <PreviewSlide
                    file={item}
                    displayUrl={displayUrl}
                    originalUrl={entry?.originalUrl}
                    previewUrl={entry?.previewUrl}
                    isActive={i === index}
                    isZoomed={i === index ? isZoomed : false}
                    width={pageWidth}
                    bottomInset={Platform.OS === 'android' ? insets.bottom : 0}
                    onZoomChange={i === index ? setIsZoomed : undefined}
                    onSwipeOpenPanel={openPanel}
                    onSwipeClosePanel={closePanel}
                    panelOpen={panelOpen}
                    panelProgress={panelProgress}
                    panelHeight={panelHeight}
                    headStatus={itemHead?.status}
                    sizeBytes={itemSizeBytes}
                    localUri={itemLocalUri}
                    triggerDownload={itemTriggerDownload}
                    onPlayLocal={handlePlayLocal}
                  />
                );
              }}
            />
          </View>

          {/* Bottom-anchored details panel. Fixed height = 50% of screen, fully
              opaque, slides up from below by exactly that height on open. */}
          <Animated.View
            style={[
              styles.panelOuter,
              { height: panelHeight, backgroundColor: colors.surfaceElevated },
              panelOuterStyle,
            ]}>
            {current && (
              <MetadataPanel
                fileKey={current.key}
                entry={headCache.get(current.key)}
                bottomInset={insets.bottom}
                onClose={closePanel}
              />
            )}
          </Animated.View>

          {/* Header — back button (left), ellipsis menu trigger (right). */}
          <View style={[styles.header, { paddingTop: insets.top + 12 }]}>
            <Pressable
              onPress={handleClose}
              hitSlop={12}
              accessibilityRole="button"
              accessibilityLabel="Back"
              style={({ pressed }) => [
                styles.headerIconButton,
                { opacity: pressed ? 0.6 : 1 },
              ]}>
              <IconSymbol name="chevron.left" size={26} color="#fff" />
            </Pressable>
            <Pressable
              onPress={() => setMenuOpen((v) => !v)}
              hitSlop={12}
              accessibilityRole="button"
              accessibilityLabel="More options"
              style={({ pressed }) => [
                styles.headerIconButton,
                { opacity: pressed ? 0.6 : 1 },
              ]}>
              <IconSymbol name="ellipsis" size={24} color="#fff" />
            </Pressable>
          </View>

          {/* Menu overlay — popover with Details + Save to Files + (conditionally) Play offline. */}
          {menuOpen && (
            <>
              <Pressable
                style={styles.menuBackdrop}
                onPress={() => setMenuOpen(false)}
                accessibilityRole="button"
                accessibilityLabel="Close menu"
              />
              <View
                style={[
                  styles.menu,
                  {
                    top: insets.top + 12 + 38 + 8,
                    backgroundColor: colors.surfaceElevated,
                    borderColor: colors.border,
                  },
                ]}>
                <MenuItem
                  icon="line.3.horizontal.decrease.circle"
                  label="Details"
                  onPress={handleMenuDetails}
                  colors={colors}
                />
                <View style={[styles.menuDivider, { backgroundColor: colors.divider }]} />
                <MenuItem
                  icon="arrow.down.to.line"
                  label="Save to Files"
                  onPress={handleMenuDownload}
                  disabled={!currentDownloadUrl || downloading}
                  trailing={downloading ? <ActivityIndicator size="small" color={colors.tint} /> : null}
                  colors={colors}
                />
                {isCurrentSlideOfflineEligible && (
                  <>
                    <View style={[styles.menuDivider, { backgroundColor: colors.divider }]} />
                    <MenuItem
                      icon="arrow.down.circle"
                      label="Play offline"
                      onPress={handleMenuPlayOffline}
                      colors={colors}
                    />
                  </>
                )}
              </View>
            </>
          )}
        </View>
      </GestureHandlerRootView>
    </Modal>
  );
}

function MenuItem({
  icon,
  label,
  onPress,
  disabled = false,
  trailing,
  colors,
}: {
  icon: Parameters<typeof IconSymbol>[0]['name'];
  label: string;
  onPress: () => void;
  disabled?: boolean;
  trailing?: React.ReactNode;
  colors: (typeof Colors)['light'];
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={({ pressed }) => [
        styles.menuItem,
        { opacity: disabled ? 0.4 : pressed ? 0.6 : 1 },
      ]}>
      <IconSymbol name={icon} size={20} color={colors.text} />
      <ThemedText style={[Type.label, styles.menuLabel, { color: colors.text }]}>
        {label}
      </ThemedText>
      {trailing}
    </Pressable>
  );
}

type SlideProps = {
  file: PreviewFile;
  /** URL for display: preview-tier JPEG for images, preview MP4 or original for video/other. */
  displayUrl: string | undefined;
  /** Original signed URL — used for video player fallback and Download button. */
  originalUrl: string | undefined;
  /** Preview MP4 URL if the transcode job has completed (video only). */
  previewUrl: string | undefined;
  isActive: boolean;
  isZoomed: boolean;
  width: number;
  /** Android bottom inset for the video player bar. */
  bottomInset: number;
  onZoomChange?: (zoomed: boolean) => void;
  onSwipeOpenPanel: () => void;
  onSwipeClosePanel: () => void;
  panelOpen: boolean;
  panelProgress: SharedValue<number>;
  panelHeight: number;
  /** Status of the /head fetch for this file. */
  headStatus: HeadEntry['status'] | undefined;
  /** Content-Length from /head, in bytes. */
  sizeBytes: number | undefined;
  /** Local file:// URI if the user has already downloaded this video offline. */
  localUri: string | undefined;
  /** Bumped from the parent to trigger a download from the menu "Play offline" item. */
  triggerDownload: number;
  /** Called when a local download completes. Parent stores the URI in localVideoUris. */
  onPlayLocal: (key: string, localUri: string) => void;
};

function PreviewSlide({
  file,
  displayUrl,
  originalUrl,
  previewUrl,
  isActive,
  isZoomed,
  width,
  bottomInset,
  onZoomChange,
  onSwipeOpenPanel,
  onSwipeClosePanel,
  panelOpen,
  panelProgress,
  panelHeight,
  headStatus,
  sizeBytes,
  localUri,
  triggerDownload,
  onPlayLocal,
}: SlideProps) {
  const filename = basename(file.key);

  // Per-slide vertical translation when the panel is open:
  // - video: shift up by the full panel height so native controls clear the panel.
  // - image / other: shift up by half the panel height so the visible media
  //   re-centres in the upper portion of the screen (push, not overlay).
  const slideAnimStyle = useAnimatedStyle(
    () => {
      'worklet';
      const offset = file.kind === 'video' ? panelHeight : panelHeight / 2;
      return { transform: [{ translateY: -offset * panelProgress.value }] };
    },
    [panelHeight, file.kind],
  );

  // Vertical pan gesture: only active on the focused slide. Disabled while zoomed
  // (so the image pan gesture wins) and skipped for video (native controls handle it).
  const panGesture = Gesture.Pan()
    .enabled(isActive && !isZoomed && file.kind !== 'video')
    .activeOffsetY([-15, 15])
    .failOffsetX([-20, 20])
    .onEnd((e) => {
      'worklet';
      if (e.translationY < -SWIPE_THRESHOLD) {
        runOnJS(onSwipeOpenPanel)();
      } else if (e.translationY > SWIPE_THRESHOLD && panelOpen) {
        runOnJS(onSwipeClosePanel)();
      }
    });

  // Determine what to render inside the video branch.
  function renderVideoContent() {
    if (!displayUrl) {
      // URL not yet fetched.
      return <ActivityIndicator color="#fff" />;
    }

    if (headStatus === 'loading') {
      // /head in flight — withhold playback until we know the file size.
      return <ActivityIndicator color="#fff" />;
    }

    // If we already have a local copy, play it directly.
    if (localUri) {
      return <VideoSlide uri={localUri} isActive={isActive} bottomInset={bottomInset} />;
    }

    // Large video with no preview MP4 — gate streaming and prompt the user.
    if (
      headStatus === 'ok' &&
      previewUrl == null &&
      sizeBytes != null &&
      sizeBytes >= LARGE_VIDEO_THRESHOLD_BYTES
    ) {
      return (
        <LargeVideoPrompt
          originalUrl={originalUrl ?? displayUrl}
          filename={filename}
          isActive={isActive}
          triggerDownload={triggerDownload}
          onPlayLocal={(uri) => onPlayLocal(file.key, uri)}
        />
      );
    }

    // Stream: either headStatus === 'unavailable', or size is below threshold,
    // or a preview MP4 is available (displayUrl is already the preview URL).
    return <VideoSlide uri={displayUrl} isActive={isActive} bottomInset={bottomInset} />;
  }

  return (
    <GestureDetector gesture={panGesture}>
      <Animated.View
        style={[{ width, height: '100%' }, slideAnimStyle]}
        pointerEvents={isActive ? 'auto' : 'none'}>
        <View style={styles.slide}>
          {file.kind === 'video' ? (
            renderVideoContent()
          ) : (
            <>
              {!displayUrl && <ActivityIndicator color="#fff" />}
              {displayUrl && file.kind === 'image' && (
                <ZoomableImage uri={displayUrl} onZoomChange={onZoomChange} />
              )}
              {displayUrl && file.kind === 'other' && (
                <ThemedView style={styles.noPreview}>
                  <ThemedText type="defaultSemiBold">No preview available</ThemedText>
                  <ThemedText style={{ opacity: 0.7, textAlign: 'center' }}>
                    {filename} can't be previewed in the app. Use Download to save it.
                  </ThemedText>
                </ThemedView>
              )}
            </>
          )}
        </View>
      </Animated.View>
    </GestureDetector>
  );
}

function VideoSlide({ uri, isActive, bottomInset }: { uri: string; isActive: boolean; bottomInset: number }) {
  const player = useVideoPlayer(uri, (p) => {
    p.loop = false;
    p.bufferOptions = VIDEO_BUFFER_OPTIONS;
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

type DownloadState = 'idle' | 'downloading' | 'error';

function LargeVideoPrompt({
  originalUrl,
  filename,
  isActive,
  triggerDownload,
  onPlayLocal,
}: {
  originalUrl: string;
  filename: string;
  isActive: boolean;
  triggerDownload: number;
  onPlayLocal: (localUri: string) => void;
}) {
  const colorScheme = useColorScheme() ?? 'light';
  const colors = Colors[colorScheme];

  const [state, setState] = useState<DownloadState>('idle');
  const [progress, setProgress] = useState(0);

  // Stable refs so the cleanup effect doesn't need to re-subscribe.
  const resumableRef = useRef<DownloadResumable | null>(null);
  const localUriRef = useRef<string | null>(null);

  async function startDownload() {
    if (state === 'downloading') return;
    // Unique filename avoids collisions between different slides / retries.
    const random = Math.random().toString(36).slice(2, 8);
    const target = `${documentDirectory}s3b-offline-${Date.now()}-${random}-${filename}`;
    localUriRef.current = target;

    setState('downloading');
    setProgress(0);

    const resumable = createDownloadResumable(
      originalUrl,
      target,
      {},
      (data) => {
        const { totalBytesWritten, totalBytesExpectedToWrite } = data;
        if (totalBytesExpectedToWrite > 0) {
          setProgress(totalBytesWritten / totalBytesExpectedToWrite);
        }
      },
    );
    resumableRef.current = resumable;

    try {
      const result = await resumable.downloadAsync();
      if (!result) {
        // Cancelled — cleanup handled by the cancel path.
        return;
      }
      localUriRef.current = result.uri;
      onPlayLocal(result.uri);
      // Parent will re-render this slide as VideoSlide — no further state needed.
    } catch (err) {
      setState('error');
      Alert.alert(
        'Download failed',
        err instanceof Error ? err.message : 'Unknown error',
      );
      await deleteAsync(target, { idempotent: true }).catch(() => {});
    }
  }

  async function cancelDownload() {
    await resumableRef.current?.cancelAsync().catch(() => {});
    resumableRef.current = null;
    if (localUriRef.current) {
      await deleteAsync(localUriRef.current, { idempotent: true }).catch(() => {});
      localUriRef.current = null;
    }
    setState('idle');
    setProgress(0);
  }

  // When the menu "Play offline" item bumps triggerDownload, auto-start if idle.
  useEffect(() => {
    if (triggerDownload > 0 && state === 'idle') {
      startDownload();
    }
    // Only react to counter bumps, not to state changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [triggerDownload]);

  // Cancel in-flight download and delete temp file when the slide goes off-screen
  // or the component unmounts. This prevents orphaned downloads consuming bandwidth.
  useEffect(() => {
    if (isActive) return;
    resumableRef.current?.cancelAsync().catch(() => {});
    if (localUriRef.current) {
      deleteAsync(localUriRef.current, { idempotent: true }).catch(() => {});
      localUriRef.current = null;
    }
  }, [isActive]);

  useEffect(() => {
    return () => {
      resumableRef.current?.cancelAsync().catch(() => {});
      if (localUriRef.current) {
        deleteAsync(localUriRef.current, { idempotent: true }).catch(() => {});
      }
    };
  }, []);

  return (
    <View style={styles.largeVideoPrompt}>
      <View
        style={[
          styles.largeVideoCard,
          { backgroundColor: colors.surfaceElevated, borderColor: colors.border },
        ]}>
        <IconSymbol name="film" size={32} color={colors.tint} />
        <ThemedText style={[Type.bodyStrong, { color: colors.text, textAlign: 'center' }]}>
          {filename}
        </ThemedText>
        <ThemedText style={[Type.label, { color: colors.muted, textAlign: 'center' }]}>
          This video is large — download to play offline?
        </ThemedText>

        {state === 'idle' && (
          <Pressable
            onPress={startDownload}
            accessibilityRole="button"
            accessibilityLabel="Play offline"
            style={({ pressed }) => [
              styles.largeVideoButton,
              { backgroundColor: colors.tint, opacity: pressed ? 0.8 : 1 },
            ]}>
            <ThemedText style={[Type.label, { color: colors.onAccent }]}>Play offline</ThemedText>
          </Pressable>
        )}

        {state === 'downloading' && (
          <>
            <View style={[styles.progressTrack, { backgroundColor: colors.border }]}>
              <View
                style={[
                  styles.progressFill,
                  { backgroundColor: colors.tint, width: `${Math.round(progress * 100)}%` },
                ]}
              />
            </View>
            <ThemedText style={[Type.meta, { color: colors.muted }]}>
              {Math.round(progress * 100)}%
            </ThemedText>
            <Pressable
              onPress={cancelDownload}
              accessibilityRole="button"
              accessibilityLabel="Cancel download"
              style={({ pressed }) => [
                styles.largeVideoButton,
                { backgroundColor: colors.surfaceMuted, opacity: pressed ? 0.7 : 1 },
              ]}>
              <ThemedText style={[Type.label, { color: colors.text }]}>Cancel</ThemedText>
            </Pressable>
          </>
        )}

        {state === 'error' && (
          <Pressable
            onPress={() => { setState('idle'); startDownload(); }}
            accessibilityRole="button"
            accessibilityLabel="Retry download"
            style={({ pressed }) => [
              styles.largeVideoButton,
              { backgroundColor: colors.tint, opacity: pressed ? 0.8 : 1 },
            ]}>
            <ThemedText style={[Type.label, { color: colors.onAccent }]}>Retry</ThemedText>
          </Pressable>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: '#000',
  },
  contentArea: {
    flex: 1,
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
  },
  headerIconButton: {
    width: 38,
    height: 38,
    alignItems: 'center',
    justifyContent: 'center',
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
  panelOuter: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
  },
  menuBackdrop: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 20,
  },
  menu: {
    position: 'absolute',
    right: Spacing.md,
    minWidth: 180,
    borderRadius: Radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    paddingVertical: Spacing.xs,
    zIndex: 21,
    ...Shadow.cardElevated,
  },
  menuItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm + 2,
    gap: Spacing.md,
  },
  menuLabel: {
    flex: 1,
  },
  menuDivider: {
    height: StyleSheet.hairlineWidth,
    marginHorizontal: Spacing.sm,
  },
  largeVideoPrompt: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: Spacing.xl,
  },
  largeVideoCard: {
    width: '100%',
    maxWidth: 320,
    borderRadius: Radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    padding: Spacing.xl,
    gap: Spacing.md,
    alignItems: 'center',
    ...Shadow.cardElevated,
  },
  largeVideoButton: {
    borderRadius: Radius.md,
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.sm + 2,
    alignSelf: 'stretch',
    alignItems: 'center',
  },
  progressTrack: {
    height: 4,
    borderRadius: Radius.pill,
    overflow: 'hidden',
    alignSelf: 'stretch',
  },
  progressFill: {
    height: '100%',
    borderRadius: Radius.pill,
  },
});
