import { Pressable, StyleSheet, View, type ViewStyle } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { IconSymbol } from '@/components/ui/icon-symbol';
import type { IconSymbolName } from '@/components/ui/icon-symbol';
import { Colors, Radius, Shadow, Spacing, Type } from '@/constants/theme';
import { useColorScheme } from '@/hooks/use-color-scheme';

export type SelectionAction = {
  key: string;
  icon: IconSymbolName;
  accessibilityLabel: string;
  onPress: () => void;
  disabled?: boolean;
  tone?: 'default' | 'danger';
};

export type SelectionActionBarProps = {
  statusLabel: string;
  actions: SelectionAction[];
  onDismiss: () => void;
  dismissAccessibilityLabel?: string;
  style?: ViewStyle;
};

export function SelectionActionBar({
  statusLabel,
  actions,
  onDismiss,
  dismissAccessibilityLabel = 'Exit selection mode',
  style,
}: SelectionActionBarProps) {
  const colorScheme = useColorScheme() ?? 'light';
  const colors = Colors[colorScheme];

  return (
    <View
      style={[
        styles.container,
        { backgroundColor: colors.surface, ...Shadow.cardElevated },
        style,
      ]}>
      <ThemedText
        style={[styles.status, { color: colors.text }]}
        numberOfLines={1}>
        {statusLabel}
      </ThemedText>
      <View style={styles.actions}>
        {actions.map((action) => {
          const iconColor = action.disabled
            ? colors.icon
            : action.tone === 'danger'
              ? colors.danger
              : colors.tint;
          return (
            <Pressable
              key={action.key}
              onPress={action.onPress}
              disabled={action.disabled}
              accessibilityLabel={action.accessibilityLabel}
              accessibilityRole="button"
              style={({ pressed }) => [
                styles.iconButton,
                { opacity: action.disabled ? 0.4 : pressed ? 0.6 : 1 },
              ]}>
              <IconSymbol name={action.icon} size={22} color={iconColor} />
            </Pressable>
          );
        })}
        <Pressable
          onPress={onDismiss}
          accessibilityLabel={dismissAccessibilityLabel}
          accessibilityRole="button"
          style={({ pressed }) => [
            styles.iconButton,
            { opacity: pressed ? 0.6 : 1 },
          ]}>
          <IconSymbol name="xmark" size={22} color={colors.icon} />
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.sm,
  },
  status: {
    ...Type.bodyStrong,
    flex: 1,
    minWidth: 0,
  },
  actions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.xs,
  },
  iconButton: {
    width: 44,
    height: 44,
    borderRadius: Radius.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
