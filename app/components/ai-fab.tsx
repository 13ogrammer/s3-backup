import { Pressable, StyleSheet } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { IconSymbol } from '@/components/ui/icon-symbol';
import { Colors, Shadow, Spacing } from '@/constants/theme';
import { useColorScheme } from '@/hooks/use-color-scheme';

// Canonical tab-bar height (content only, excluding safe-area inset).
// Must match the value configured in app/(tabs)/_layout.tsx tabBarStyle.height.
export const TAB_BAR_CONTENT_HEIGHT = 48;

export const AI_FAB_SIZE = 56;
// Gap between the top of the tab bar and the bottom of the FAB.
export const AI_FAB_GAP_ABOVE_TABBAR = Spacing.md;
// Gap between the top of the FAB and any content/widget that must clear it.
export const AI_FAB_GAP_ABOVE_FAB = Spacing.lg;

// Minimum content padding (no safe-area) for scroll views on devices with
// insets.bottom === 0. Derived from: tab bar + gap + FAB + gap above FAB.
export const AI_FAB_CONTENT_PADDING_MIN =
  TAB_BAR_CONTENT_HEIGHT + AI_FAB_GAP_ABOVE_TABBAR + AI_FAB_SIZE + AI_FAB_GAP_ABOVE_FAB;

type AiFabClearance = {
  /** Use as contentContainerStyle.paddingBottom on all scrollable lists. */
  contentPaddingBottom: number;
  /** Use as `bottom` for absolutely-positioned widgets that must sit above the FAB. */
  aboveFabBottom: number;
  /** FAB's own bottom offset (single source of truth). */
  fabBottom: number;
};

export function useAiFabClearance(): AiFabClearance {
  const insets = useSafeAreaInsets();
  const fabBottom = insets.bottom + TAB_BAR_CONTENT_HEIGHT + AI_FAB_GAP_ABOVE_TABBAR;
  const aboveFabBottom = fabBottom + AI_FAB_SIZE + AI_FAB_GAP_ABOVE_FAB;
  const contentPaddingBottom = aboveFabBottom;
  return { contentPaddingBottom, aboveFabBottom, fabBottom };
}

type Props = { onPress: () => void; visible?: boolean };

export function AiFab({ onPress, visible = true }: Props) {
  const colorScheme = useColorScheme() ?? 'light';
  const colors = Colors[colorScheme];
  const { fabBottom } = useAiFabClearance();

  if (!visible) return null;

  return (
    <Pressable
      onPress={onPress}
      hitSlop={8}
      accessibilityLabel="Open AI assistant"
      accessibilityRole="button"
      style={({ pressed }) => [
        styles.fab,
        {
          backgroundColor: colors.tint,
          bottom: fabBottom,
          opacity: pressed ? 0.8 : 1,
          ...Shadow.cardElevated,
        },
      ]}>
      <IconSymbol name="sparkles" size={26} color={colors.onAccent} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  fab: {
    position: 'absolute',
    right: Spacing.lg,
    width: AI_FAB_SIZE,
    height: AI_FAB_SIZE,
    borderRadius: AI_FAB_SIZE / 2,
    alignItems: 'center',
    justifyContent: 'center',
    // Android: elevation is spread via Shadow.cardElevated; zIndex pairs with
    // render-order (FAB mounted after Tabs in _layout.tsx).
    zIndex: 100,
    elevation: 8,
  },
});
