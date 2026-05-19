import { Modal, Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ThemedText } from '@/components/themed-text';
import { Colors, Radius, Shadow, Spacing, Type } from '@/constants/theme';
import { useColorScheme } from '@/hooks/use-color-scheme';

export type BottomSheetItem = {
  label: string;
  onPress: () => void;
  destructive?: boolean;
  /** Show a leading checkmark to mark this item as the active choice. */
  active?: boolean;
};

export type BottomSheetProps = {
  visible: boolean;
  onClose: () => void;
  title?: string;
  items: BottomSheetItem[];
};

/**
 * Bottom-anchored sheet that slides up from below. Used for secondary
 * selection menus (e.g. Sort / Filter) reached from the header overflow.
 */
export function BottomSheet({ visible, onClose, title, items }: BottomSheetProps) {
  const colorScheme = useColorScheme() ?? 'light';
  const colors = Colors[colorScheme];
  const insets = useSafeAreaInsets();

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      statusBarTranslucent
      navigationBarTranslucent
      onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        {/* Stop touches on the sheet from bubbling to the backdrop */}
        <Pressable
          onPress={() => {}}
          style={[
            styles.sheet,
            {
              backgroundColor: colors.surfaceElevated,
              paddingBottom: insets.bottom + Spacing.lg,
            },
          ]}>
          <View style={styles.handleRow}>
            <View style={[styles.handle, { backgroundColor: colors.border }]} />
          </View>
          {title && (
            <ThemedText
              style={[Type.section, styles.title, { color: colors.text }]}>
              {title}
            </ThemedText>
          )}
          {items.map((item, idx) => (
            <View key={item.label}>
              {idx > 0 && (
                <View style={[styles.divider, { backgroundColor: colors.divider }]} />
              )}
              <Pressable
                onPress={() => {
                  onClose();
                  item.onPress();
                }}
                style={({ pressed }) => [styles.item, { opacity: pressed ? 0.6 : 1 }]}>
                <View style={styles.checkSlot}>
                  {item.active && (
                    <ThemedText style={[styles.check, { color: colors.tint }]}>
                      ✓
                    </ThemedText>
                  )}
                </View>
                <ThemedText
                  style={[
                    Type.body,
                    styles.itemLabel,
                    { color: item.destructive ? colors.danger : colors.text },
                  ]}>
                  {item.label}
                </ThemedText>
              </Pressable>
            </View>
          ))}
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.4)',
    justifyContent: 'flex-end',
  },
  sheet: {
    borderTopLeftRadius: Radius.xl,
    borderTopRightRadius: Radius.xl,
    paddingHorizontal: Spacing.lg,
    paddingTop: Spacing.sm,
    ...Shadow.cardElevated,
  },
  handleRow: {
    alignItems: 'center',
    paddingVertical: Spacing.xs,
  },
  handle: {
    width: 36,
    height: 4,
    borderRadius: Radius.pill,
  },
  title: {
    paddingTop: Spacing.xs,
    paddingBottom: Spacing.sm,
  },
  item: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: Spacing.md,
  },
  checkSlot: {
    width: 22,
    alignItems: 'center',
  },
  check: {
    fontSize: 16,
    fontWeight: '700',
  },
  itemLabel: {
    flex: 1,
    marginLeft: Spacing.xs,
  },
  divider: {
    height: StyleSheet.hairlineWidth,
  },
});
