import { type AccessibilityRole, Modal, Pressable, StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Colors, Radius, Shadow, Spacing, Type } from '@/constants/theme';
import { useColorScheme } from '@/hooks/use-color-scheme';

export type ModalCardProps = {
  visible: boolean;
  onRequestClose: () => void;
  /** When true (default), tapping the backdrop calls onRequestClose. */
  dismissOnBackdrop?: boolean;
  /** Optional heading rendered at the top of the card. */
  title?: string;
  /** Maximum card width (default 420). */
  maxWidth?: number;
  children: React.ReactNode;
  testID?: string;
  /** Forwarded to the card View — useful for alert-style modals. */
  accessibilityViewIsModal?: boolean;
  /** Forwarded to the card View — useful for alert-style modals. */
  accessibilityRole?: AccessibilityRole;
};

export function ModalCard({
  visible,
  onRequestClose,
  dismissOnBackdrop = true,
  title,
  maxWidth = 420,
  children,
  testID,
  accessibilityViewIsModal,
  accessibilityRole,
}: ModalCardProps) {
  const colorScheme = useColorScheme() ?? 'light';
  const colors = Colors[colorScheme];

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onRequestClose}
      testID={testID}>
      {/* Backdrop — tapping calls onRequestClose when dismissOnBackdrop=true */}
      <Pressable
        style={styles.backdrop}
        onPress={dismissOnBackdrop ? onRequestClose : undefined}>
        {/* Stop touches propagating from the card to the backdrop */}
        <Pressable onPress={() => {}}>
          <ThemedView
            style={[
              styles.card,
              { maxWidth, borderColor: colors.border },
            ]}
            accessibilityViewIsModal={accessibilityViewIsModal}
            accessibilityRole={accessibilityRole}>
            {title !== undefined && (
              <ThemedText style={styles.title}>{title}</ThemedText>
            )}
            <View style={styles.content}>{children}</View>
          </ThemedView>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.45)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: Spacing.xl,
  },
  card: {
    width: '100%',
    borderRadius: Radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    padding: Spacing.lg,
    gap: Spacing.md,
    ...Shadow.cardElevated,
  },
  title: {
    ...Type.bodyStrong,
  },
  content: {
    gap: Spacing.md,
  },
});
