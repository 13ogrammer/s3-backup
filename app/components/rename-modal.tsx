import { useEffect, useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { ModalCard } from '@/components/ui/modal-card';
import { Colors, Radius, Spacing } from '@/constants/theme';
import { useColorScheme } from '@/hooks/use-color-scheme';

type Props = {
  visible: boolean;
  title: string;
  initialValue: string;
  /** Value to compare against to detect "unchanged". Defaults to initialValue.
   *  Pass the original name when initialValue is a suggested new name (e.g.
   *  collision rename), so submitting the pre-filled suggestion isn't treated
   *  as a no-op. */
  originalValue?: string;
  /** Inline error message shown below the text input (e.g. folder-too-large). */
  errorMessage?: string;
  /** Submit button label. Defaults to "Rename"; pass "Rename and Move" or "Move"
   *  when the modal is re-opened after a collision during a move-to-destination. */
  submitLabel?: string;
  onCancel: () => void;
  onSubmit: (newName: string) => void;
};

export function RenameModal({ visible, title, initialValue, originalValue, errorMessage, submitLabel, onCancel, onSubmit }: Props) {
  const colorScheme = useColorScheme() ?? 'light';
  const colors = Colors[colorScheme];

  const [value, setValue] = useState(initialValue);
  const baseline = originalValue ?? initialValue;

  useEffect(() => {
    if (visible) setValue(initialValue);
  }, [visible, initialValue]);

  function submit() {
    const trimmed = value.trim();
    if (!trimmed || trimmed === baseline) {
      onCancel();
      return;
    }
    onSubmit(trimmed);
  }

  return (
    <KeyboardAvoidingView
      style={StyleSheet.absoluteFill}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      pointerEvents={visible ? 'auto' : 'none'}>
      <ModalCard visible={visible} onRequestClose={onCancel} title={title}>
        <TextInput
          value={value}
          onChangeText={setValue}
          autoCapitalize="none"
          autoCorrect={false}
          autoFocus
          onSubmitEditing={submit}
          returnKeyType="done"
          placeholderTextColor={colors.muted}
          style={[
            styles.input,
            { color: colors.text, backgroundColor: colors.surfaceMuted },
          ]}
        />
        {errorMessage && (
          <View style={styles.errorRow}>
            <ThemedText style={[styles.errorText, { color: colors.danger }]}>
              {errorMessage}
            </ThemedText>
          </View>
        )}
        <View style={styles.actions}>
          <Pressable
            onPress={onCancel}
            style={({ pressed }) => [styles.button, { opacity: pressed ? 0.6 : 1 }]}>
            <ThemedText>Cancel</ThemedText>
          </Pressable>
          <Pressable
            onPress={submit}
            disabled={!value.trim() || value.trim() === baseline}
            style={({ pressed }) => [
              styles.button,
              {
                opacity:
                  pressed || !value.trim() || value.trim() === baseline ? 0.6 : 1,
              },
            ]}>
            <ThemedText style={{ color: colors.tint, fontWeight: '600' }}>{submitLabel ?? 'Rename'}</ThemedText>
          </Pressable>
        </View>
      </ModalCard>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  input: {
    borderRadius: Radius.md,
    paddingHorizontal: Spacing.md,
    paddingVertical: 12,
    fontSize: 16,
  },
  actions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: Spacing.lg,
    marginTop: Spacing.xs,
  },
  button: { paddingVertical: 8, paddingHorizontal: Spacing.md },
  errorRow: {
    marginTop: Spacing.xs,
  },
  errorText: {
    fontSize: 13,
  },
});
