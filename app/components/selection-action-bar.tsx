import { Pressable, StyleSheet, View, type ViewStyle } from 'react-native';

import { useSuppressAiFab } from '@/components/ai-fab';
import { ThemedText } from '@/components/themed-text';
import { IconSymbol } from '@/components/ui/icon-symbol';
import type { IconSymbolName } from '@/components/ui/icon-symbol';
import { Colors, Radius, Shadow, Spacing, Type } from '@/constants/theme';
import { useColorScheme } from '@/hooks/use-color-scheme';

export type SelectionAction = {
  key: string;
  icon: IconSymbolName;
  label: string;
  accessibilityLabel: string;
  onPress: () => void;
  disabled?: boolean;
  tone?: 'default' | 'danger';
};

export type SelectionActionBarProps = {
  statusLabel: string;
  actions: SelectionAction[];
  onDismiss: () => void;
  dismissLabel?: string;
  dismissAccessibilityLabel?: string;
  style?: ViewStyle;
};

export function SelectionActionBar({
  statusLabel,
  actions,
  onDismiss,
  dismissLabel = 'Cancel',
  dismissAccessibilityLabel = 'Exit selection mode',
  style,
}: SelectionActionBarProps) {
  const colorScheme = useColorScheme() ?? 'light';
  const colors = Colors[colorScheme];
  useSuppressAiFab();

  return (
    <View
      style={[
        styles.container,
        { backgroundColor: colors.accentSoft, ...Shadow.cardElevated },
        style,
      ]}>
      <View style={styles.statusRow}>
        <ThemedText
          style={[styles.status, { color: colors.text }]}
          numberOfLines={1}>
          {statusLabel}
        </ThemedText>
      </View>
      <View style={styles.actions}>
        {actions.map((action) => {
          const tintColor = action.tone === 'danger' ? colors.danger : colors.tint;
          return (
            <Pressable
              key={action.key}
              onPress={action.onPress}
              disabled={action.disabled}
              accessibilityLabel={action.accessibilityLabel}
              accessibilityRole="button"
              style={({ pressed }) => [
                styles.actionButton,
                { opacity: action.disabled ? 0.4 : pressed ? 0.6 : 1 },
              ]}>
              <IconSymbol name={action.icon} size={22} color={tintColor} />
              <ThemedText
                style={[styles.actionLabel, { color: tintColor }]}
                numberOfLines={1}>
                {action.label}
              </ThemedText>
            </Pressable>
          );
        })}
        <Pressable
          onPress={onDismiss}
          accessibilityLabel={dismissAccessibilityLabel}
          accessibilityRole="button"
          style={({ pressed }) => [
            styles.actionButton,
            { opacity: pressed ? 0.6 : 1 },
          ]}>
          <IconSymbol name="xmark" size={22} color={colors.text} />
          <ThemedText
            style={[styles.actionLabel, { color: colors.text }]}
            numberOfLines={1}>
            {dismissLabel}
          </ThemedText>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'column',
    paddingHorizontal: Spacing.lg,
    paddingTop: Spacing.sm,
    paddingBottom: Spacing.sm,
    gap: Spacing.xs,
  },
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  status: {
    ...Type.meta,
    flex: 1,
    minWidth: 0,
  },
  actions: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: Spacing.xs,
  },
  actionButton: {
    flex: 1,
    minWidth: 44,
    paddingVertical: Spacing.xs,
    borderRadius: Radius.md,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 2,
  },
  actionLabel: {
    ...Type.meta,
  },
});
