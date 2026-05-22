import { useEffect, useRef } from 'react';
import {
  type AccessibilityRole,
  Animated,
  Easing,
  Keyboard,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
} from 'react-native';

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

  // Track the keyboard so the card lifts above it instead of being clipped.
  // RN's Modal renders in its own native window, so KeyboardAvoidingView is
  // unreliable here — manual padding on the backdrop works on both platforms.
  const keyboardPad = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const showEvent = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvent = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const show = Keyboard.addListener(showEvent, (e) => {
      const target = e.endCoordinates.height;
      if (Platform.OS === 'ios') {
        Animated.timing(keyboardPad, {
          toValue: target,
          duration: e.duration ?? 250,
          easing: Easing.bezier(0.17, 0.59, 0.4, 0.77),
          useNativeDriver: false,
        }).start();
      } else {
        keyboardPad.setValue(target);
      }
    });
    const hide = Keyboard.addListener(hideEvent, (e) => {
      if (Platform.OS === 'ios') {
        Animated.timing(keyboardPad, {
          toValue: 0,
          duration: e.duration ?? 250,
          easing: Easing.bezier(0.17, 0.59, 0.4, 0.77),
          useNativeDriver: false,
        }).start();
      } else {
        keyboardPad.setValue(0);
      }
    });
    return () => {
      show.remove();
      hide.remove();
    };
  }, [keyboardPad]);

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onRequestClose}
      testID={testID}>
      <Pressable
        style={styles.backdropPressable}
        onPress={dismissOnBackdrop ? onRequestClose : undefined}>
        <Animated.View
          style={[styles.backdrop, { paddingBottom: keyboardPad }]}
          pointerEvents="box-none">
          <Pressable style={[styles.cardWrapper, { maxWidth }]} onPress={() => {}}>
            <ThemedView
              style={[styles.card, { borderColor: colors.border }]}
              accessibilityViewIsModal={accessibilityViewIsModal}
              accessibilityRole={accessibilityRole}>
              {title !== undefined && (
                <ThemedText style={styles.title}>{title}</ThemedText>
              )}
              <ScrollView
                style={styles.scroll}
                contentContainerStyle={styles.scrollContent}
                keyboardShouldPersistTaps="handled"
                showsVerticalScrollIndicator={false}>
                {children}
              </ScrollView>
            </ThemedView>
          </Pressable>
        </Animated.View>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdropPressable: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.45)',
  },
  backdrop: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: Spacing.xl,
  },
  cardWrapper: {
    width: '100%',
  },
  card: {
    width: '100%',
    maxHeight: '100%',
    borderRadius: Radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    padding: Spacing.lg,
    gap: Spacing.md,
    ...Shadow.cardElevated,
  },
  title: {
    ...Type.bodyStrong,
  },
  scroll: {
    flexGrow: 0,
  },
  scrollContent: {
    gap: Spacing.md,
  },
});
