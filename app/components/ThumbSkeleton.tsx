import { LinearGradient } from 'expo-linear-gradient';
import { useEffect } from 'react';
import { StyleProp, View, ViewStyle } from 'react-native';
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';

import { Colors, Radius } from '@/constants/theme';
import { useColorScheme } from '@/hooks/use-color-scheme';

export type ThumbSkeletonProps = {
  width: number;
  height: number;
  borderRadius?: number;
  style?: StyleProp<ViewStyle>;
};

export function ThumbSkeleton({ width, height, borderRadius, style }: ThumbSkeletonProps) {
  const scheme = useColorScheme() ?? 'light';
  const base = Colors[scheme].skeletonBase;
  const highlight = Colors[scheme].skeletonHighlight;
  const radius = borderRadius ?? Radius.md;

  const progress = useSharedValue(0);

  useEffect(() => {
    progress.value = withRepeat(
      withTiming(1, { duration: 1200, easing: Easing.linear }),
      -1,
      false,
    );
    return () => {
      progress.value = 0;
    };
  }, [progress]);

  // The gradient band is 2x wide so it can sweep fully across the tile.
  const bandWidth = width * 2;

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: -bandWidth + progress.value * bandWidth * 2 }],
  }));

  return (
    <View
      style={[
        {
          width,
          height,
          borderRadius: radius,
          backgroundColor: base,
          overflow: 'hidden',
        },
        style,
      ]}>
      <Animated.View style={[{ width: bandWidth, height }, animatedStyle]}>
        <LinearGradient
          colors={[base, highlight, base]}
          locations={[0, 0.5, 1]}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 0 }}
          style={{ width: bandWidth, height }}
        />
      </Animated.View>
    </View>
  );
}
