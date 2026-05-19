import { Modal, Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Colors, Radius, Shadow, Spacing, Type } from '@/constants/theme';
import { useColorScheme } from '@/hooks/use-color-scheme';

export type ActionSheetItem = {
  label: string;
  onPress: () => void;
  destructive?: boolean;
};

export type ActionSheetProps = {
  visible: boolean;
  onClose: () => void;
  items: ActionSheetItem[];
};

/**
 * Themed bottom action-sheet. Uses a native Modal with a Pressable backdrop so
 * tapping outside always dismisses. Safe-area aware — insets pushed to the
 * panel so content sits above the home indicator on notched devices.
 */
export function ActionSheet({ visible, onClose, items }: ActionSheetProps) {
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
        {/* Stop touches from the panel propagating to the backdrop */}
        <Pressable onPress={() => {}}>
          <ThemedView
            style={[
              styles.panel,
              {
                borderColor: colors.border,
                paddingBottom: Math.max(insets.bottom, Spacing.lg),
              },
            ]}>
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
                  <ThemedText
                    style={[
                      Type.body,
                      { color: item.destructive ? colors.danger : colors.text },
                    ]}>
                    {item.label}
                  </ThemedText>
                </Pressable>
              </View>
            ))}
          </ThemedView>
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
  panel: {
    borderTopLeftRadius: Radius.xl,
    borderTopRightRadius: Radius.xl,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderLeftWidth: StyleSheet.hairlineWidth,
    borderRightWidth: StyleSheet.hairlineWidth,
    paddingTop: Spacing.lg,
    paddingHorizontal: Spacing.lg,
    ...Shadow.cardElevated,
  },
  item: {
    paddingVertical: Spacing.md,
  },
  divider: {
    height: StyleSheet.hairlineWidth,
  },
});
