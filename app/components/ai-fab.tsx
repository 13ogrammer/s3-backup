import { Pressable, StyleSheet } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { IconSymbol } from '@/components/ui/icon-symbol';
import { Colors, Shadow, Spacing } from '@/constants/theme';
import { useColorScheme } from '@/hooks/use-color-scheme';
import { TAB_BAR_CONTENT_HEIGHT } from '@/components/jobs-strip';

type Props = { onPress: () => void; visible?: boolean };

export function AiFab({ onPress, visible = true }: Props) {
  const colorScheme = useColorScheme() ?? 'light';
  const colors = Colors[colorScheme];
  const insets = useSafeAreaInsets();

  if (!visible) return null;

  const bottomOffset = insets.bottom + TAB_BAR_CONTENT_HEIGHT + Spacing.md;

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
          bottom: bottomOffset,
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
    width: 56,
    height: 56,
    borderRadius: 28,
    alignItems: 'center',
    justifyContent: 'center',
    // Android: elevation is spread via Shadow.cardElevated; zIndex pairs with
    // render-order (FAB mounted after Tabs in _layout.tsx).
    zIndex: 100,
    elevation: 8,
  },
});
