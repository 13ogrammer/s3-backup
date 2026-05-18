import { useEffect, useRef } from 'react';
import { AccessibilityInfo, findNodeHandle, Pressable, StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { ModalCard } from '@/components/ui/modal-card';
import { Colors, Spacing } from '@/constants/theme';
import { useColorScheme } from '@/hooks/use-color-scheme';

// Mirrored from alert-provider.tsx to avoid a circular dependency.
type AlertButton = {
  text: string;
  onPress?: () => void;
  style?: 'default' | 'cancel' | 'destructive';
};

type AlertModalProps = {
  visible: boolean;
  title: string;
  message?: string;
  buttons: AlertButton[];
  cancelable: boolean;
  onDismiss: () => void;
};

export function AlertModal({
  visible,
  title,
  message,
  buttons,
  cancelable,
  onDismiss,
}: AlertModalProps) {
  const colorScheme = useColorScheme() ?? 'light';
  const colors = Colors[colorScheme];

  // Focus the first non-cancel button on open for accessibility.
  const defaultBtnRef = useRef<View>(null);
  useEffect(() => {
    if (!visible) return;
    const node = findNodeHandle(defaultBtnRef.current);
    if (node) {
      AccessibilityInfo.setAccessibilityFocus(node);
    }
  }, [visible]);

  const focusIndex = buttons.findIndex((b) => b.style !== 'cancel');
  const focusIdx = focusIndex >= 0 ? focusIndex : 0;

  return (
    <ModalCard
      visible={visible}
      onRequestClose={cancelable ? onDismiss : () => {}}
      dismissOnBackdrop={cancelable}
      accessibilityViewIsModal={true}
      accessibilityRole="alert">
      <ThemedText style={styles.title}>{title}</ThemedText>
      {message !== undefined && message !== '' && (
        <ThemedText style={[styles.message, { color: colors.muted }]}>{message}</ThemedText>
      )}
      <View style={styles.buttonRow}>
        {buttons.map((btn, i) => {
          const isDestructive = btn.style === 'destructive';
          const isCancel = btn.style === 'cancel';
          const textColor = isDestructive
            ? colors.danger
            : isCancel
              ? colors.muted
              : colors.tint;
          return (
            <Pressable
              key={i}
              ref={i === focusIdx ? (defaultBtnRef as React.Ref<View>) : undefined}
              onPress={() => {
                onDismiss();
                btn.onPress?.();
              }}
              style={({ pressed }) => [styles.button, { opacity: pressed ? 0.6 : 1 }]}
              accessibilityRole="button">
              <ThemedText
                style={[
                  styles.buttonText,
                  { color: textColor },
                  isCancel && styles.cancelText,
                ]}>
                {btn.text}
              </ThemedText>
            </Pressable>
          );
        })}
      </View>
    </ModalCard>
  );
}

const styles = StyleSheet.create({
  title: {
    fontSize: 17,
    fontWeight: '600',
    textAlign: 'center',
  },
  message: {
    fontSize: 14,
    textAlign: 'center',
    lineHeight: 20,
  },
  buttonRow: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    flexWrap: 'wrap',
    gap: Spacing.sm,
    marginTop: Spacing.xs,
  },
  button: {
    paddingVertical: Spacing.sm,
    paddingHorizontal: Spacing.md,
  },
  buttonText: {
    fontSize: 16,
    fontWeight: '500',
  },
  cancelText: {
    fontWeight: '400',
  },
});
