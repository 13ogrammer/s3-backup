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
  /** Optional trailing text on the right (e.g. current selection hint). */
  trailing?: string;
};

export type ActionSheetProps = {
  visible: boolean;
  onClose: () => void;
  items: ActionSheetItem[];
};

// Approx. native stack-header height (status-bar excluded — accounted for via inset)
const HEADER_HEIGHT = 44;

/**
 * Themed dropdown anchored to the top-right of the screen, just below the
 * native stack header. Used for header overflow menus (e.g., the Backup tab's
 * `⋮` trigger). Tap-outside dismisses via a transparent backdrop.
 */
export function ActionSheet({ visible, onClose, items }: ActionSheetProps) {
  const colorScheme = useColorScheme() ?? 'light';
  const colors = Colors[colorScheme];
  const insets = useSafeAreaInsets();

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      statusBarTranslucent
      navigationBarTranslucent
      onRequestClose={onClose}>
      <Pressable
        style={[
          styles.backdrop,
          { paddingTop: insets.top + HEADER_HEIGHT + Spacing.xs },
        ]}
        onPress={onClose}>
        {/* Stop touches from the panel propagating to the backdrop */}
        <Pressable onPress={() => {}}>
          <ThemedView style={[styles.panel, { borderColor: colors.border }]}>
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
                  <View style={styles.itemRow}>
                    <ThemedText
                      style={[
                        Type.body,
                        styles.itemLabel,
                        { color: item.destructive ? colors.danger : colors.text },
                      ]}>
                      {item.label}
                    </ThemedText>
                    {item.trailing && (
                      <ThemedText
                        style={[Type.body, { color: colors.muted, marginLeft: Spacing.md }]}>
                        {item.trailing}
                      </ThemedText>
                    )}
                  </View>
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
    backgroundColor: 'rgba(0,0,0,0.2)',
    alignItems: 'flex-end',
    paddingRight: Spacing.sm,
  },
  panel: {
    minWidth: 180,
    borderRadius: Radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    paddingVertical: Spacing.xs,
    paddingHorizontal: Spacing.lg,
    ...Shadow.cardElevated,
  },
  item: {
    paddingVertical: Spacing.md,
  },
  itemRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  itemLabel: {
    flex: 1,
  },
  divider: {
    height: StyleSheet.hairlineWidth,
  },
});
