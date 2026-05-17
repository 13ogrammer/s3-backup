import { Image } from 'expo-image';
import React, { memo } from 'react';
import { Platform, StyleSheet, View } from 'react-native';

import { IconSymbol } from '@/components/ui/icon-symbol';
import { Colors, Radius, Shadow } from '@/constants/theme';
import { useColorScheme } from '@/hooks/use-color-scheme';
import type { FolderPreviewThumb } from '@/lib/api';

export type FolderThumbProps = {
  prefix: string;
  size: number;
  thumbs: ReadonlyArray<FolderPreviewThumb>;
  loading: boolean;
  name?: string;
};

// Angles and zIndex for the fanned card stack (left, centre, right).
const CARD_ANGLES = [-7, 0, 7];
const CARD_Z = [1, 3, 2];

function FolderThumbInner({ size, thumbs, loading }: FolderThumbProps) {
  const scheme = useColorScheme() ?? 'light';
  const colors = Colors[scheme];

  const cardSize = Math.round(size * 0.78);
  const translateX = Math.round(size * 0.08);

  // No previews available (empty folder, videos-only, sub-folders-only): fall back
  // to the generic folder icon regardless of why there are no image thumbnails.
  if (!loading && thumbs.length === 0) {
    const iconSize = size > 40 ? 40 : 28;
    return (
      <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
        <IconSymbol name="folder" size={iconSize} color={colors.icon} />
      </View>
    );
  }

  // Loading state: 3 skeleton cards at the same rotations.
  if (loading) {
    const count = 3;
    return (
      <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
        {Array.from({ length: count }).map((_, i) => {
          const dx = i === 0 ? -translateX : i === 2 ? translateX : 0;
          return (
            <View
              key={i}
              style={[
                styles.card,
                {
                  width: cardSize,
                  height: cardSize,
                  borderRadius: Radius.md,
                  backgroundColor: colors.skeletonBase,
                  borderColor: colors.border,
                  zIndex: CARD_Z[i],
                  transform: [{ rotate: `${CARD_ANGLES[i]}deg` }, { translateX: dx }],
                },
              ]}
            />
          );
        })}
      </View>
    );
  }

  const count = Math.min(thumbs.length, 3);
  // For 1 thumb: single card (index 1 = centre, 0°). For 2: indices 0 and 2 (drop centre card index 1).
  const indices =
    count === 1 ? [1] : count === 2 ? [0, 2] : [0, 1, 2];

  return (
    <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
      {indices.map((angleIdx, renderIdx) => {
        const thumb = thumbs[renderIdx]!;
        const dx = angleIdx === 0 ? -translateX : angleIdx === 2 ? translateX : 0;
        const isVideo = thumb.kind === 'video';
        return (
          <View
            key={thumb.key}
            style={[
              styles.card,
              {
                width: cardSize,
                height: cardSize,
                borderRadius: Radius.md,
                borderColor: colors.border,
                zIndex: CARD_Z[angleIdx],
                transform: [{ rotate: `${CARD_ANGLES[angleIdx]}deg` }, { translateX: dx }],
              },
              // Shadow only on iOS — elevation on Android clips rotated views badly.
              Platform.OS === 'ios' ? Shadow.card : undefined,
            ]}>
            <Image
              source={{ uri: thumb.url }}
              style={{ width: cardSize, height: cardSize, borderRadius: Radius.md }}
              contentFit="cover"
              recyclingKey={thumb.key}
              cachePolicy="memory-disk"
            />
            {isVideo && (
              <View style={styles.videoBadge}>
                <View style={styles.videoPlay} />
              </View>
            )}
          </View>
        );
      })}
    </View>
  );
}

// Custom memo comparator: skip re-renders when only the URL changes for an
// already-known key set (pre-signed URL refreshes don't change visual output).
function areEqual(prev: FolderThumbProps, next: FolderThumbProps): boolean {
  if (
    prev.prefix !== next.prefix ||
    prev.size !== next.size ||
    prev.loading !== next.loading
  ) {
    return false;
  }
  if (prev.thumbs.length !== next.thumbs.length) return false;
  const prevSig = prev.thumbs.map((t) => t.key).join('\x00');
  const nextSig = next.thumbs.map((t) => t.key).join('\x00');
  return prevSig === nextSig;
}

export const FolderThumb = memo(FolderThumbInner, areEqual);

const styles = StyleSheet.create({
  card: {
    position: 'absolute',
    overflow: 'hidden',
    borderWidth: StyleSheet.hairlineWidth,
  },
  // Triangle "play" badge for video thumbnails — bottom-right of card.
  videoBadge: {
    position: 'absolute',
    bottom: 4,
    right: 4,
    width: 14,
    height: 14,
    borderRadius: 7,
    backgroundColor: 'rgba(0,0,0,0.55)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  // Filled triangle using border trick (no text rendering).
  videoPlay: {
    width: 0,
    height: 0,
    borderTopWidth: 4,
    borderBottomWidth: 4,
    borderLeftWidth: 7,
    borderTopColor: 'transparent',
    borderBottomColor: 'transparent',
    borderLeftColor: '#fff',
    marginLeft: 1,
  },
});
