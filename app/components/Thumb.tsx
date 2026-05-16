import { Image } from 'expo-image';
import React, { useEffect, useRef, useState } from 'react';
import { StyleProp, ImageStyle } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';

import { Radius } from '@/constants/theme';
import { ThumbSkeleton } from '@/components/ThumbSkeleton';

export type ThumbProps = {
  uri: string;
  width: number;
  height: number;
  borderRadius?: number;
  recyclingKey?: string;
  cachePolicy?: 'memory-disk' | 'memory' | 'disk' | 'none';
  contentFit?: 'cover' | 'contain';
  style?: StyleProp<ImageStyle>;
  fallback?: React.ReactNode;
};

type LoadState = 'loading' | 'loaded' | 'failed';

const MIN_DISPLAY_MS = 80;
const TIMEOUT_MS = 3000;
const FADE_MS = 150;

export function Thumb({
  uri,
  width,
  height,
  borderRadius,
  recyclingKey,
  cachePolicy = 'memory-disk',
  contentFit = 'cover',
  style,
  fallback,
}: ThumbProps) {
  const radius = borderRadius ?? Radius.md;

  const [loadState, setLoadState] = useState<LoadState>('loading');
  // skeletonVisible: true once the 80 ms min-display timer fires; stays
  // false if the image resolves before that threshold (no flash).
  const [skeletonVisible, setSkeletonVisible] = useState(false);

  const skeletonOpacity = useSharedValue(1);

  const minDisplayTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const timeoutTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimers = () => {
    if (minDisplayTimer.current) {
      clearTimeout(minDisplayTimer.current);
      minDisplayTimer.current = null;
    }
    if (timeoutTimer.current) {
      clearTimeout(timeoutTimer.current);
      timeoutTimer.current = null;
    }
  };

  useEffect(() => {
    // Reset per uri change.
    clearTimers();
    setLoadState('loading');
    setSkeletonVisible(false);
    skeletonOpacity.value = 1;

    minDisplayTimer.current = setTimeout(() => {
      setSkeletonVisible(true);
    }, MIN_DISPLAY_MS);

    timeoutTimer.current = setTimeout(() => {
      setLoadState((prev) => (prev === 'loading' ? 'failed' : prev));
    }, TIMEOUT_MS);

    return clearTimers;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uri]);

  const handleLoad = () => {
    clearTimers();
    if (skeletonVisible) {
      skeletonOpacity.value = withTiming(0, { duration: FADE_MS }, () => {
        // Unmount the skeleton after fade.
        setLoadState('loaded');
      });
    } else {
      setLoadState('loaded');
    }
  };

  const handleError = () => {
    clearTimers();
    setLoadState('failed');
  };

  const skeletonStyle = useAnimatedStyle(() => ({
    opacity: skeletonOpacity.value,
  }));

  const showSkeleton = loadState === 'loading' && skeletonVisible;
  const showFallback = loadState === 'failed';

  return (
    <>
      <Image
        source={{ uri }}
        style={[{ width, height, borderRadius: radius }, style]}
        contentFit={contentFit}
        transition={150}
        recyclingKey={recyclingKey}
        cachePolicy={cachePolicy}
        onLoad={handleLoad}
        onError={handleError}
      />
      {showSkeleton && (
        <Animated.View
          pointerEvents="none"
          style={[
            {
              position: 'absolute',
              top: 0,
              left: 0,
            },
            skeletonStyle,
          ]}>
          <ThumbSkeleton width={width} height={height} borderRadius={radius} />
        </Animated.View>
      )}
      {showFallback && fallback}
    </>
  );
}
