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
  onCancel: () => void;
  onSubmit: (newName: string) => void;
};

export function RenameModal({ visible, title, initialValue, onCancel, onSubmit }: Props) {
  const colorScheme = useColorScheme() ?? 'light';
  const colors = Colors[colorScheme];

  const [value, setValue] = useState(initialValue);

  useEffect(() => {
    if (visible) setValue(initialValue);
  }, [visible, initialValue]);

  function submit() {
    const trimmed = value.trim();
    if (!trimmed || trimmed === initialValue) {
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
        <View style={styles.actions}>
          <Pressable
            onPress={onCancel}
            style={({ pressed }) => [styles.button, { opacity: pressed ? 0.6 : 1 }]}>
            <ThemedText>Cancel</ThemedText>
          </Pressable>
          <Pressable
            onPress={submit}
            disabled={!value.trim() || value.trim() === initialValue}
            style={({ pressed }) => [
              styles.button,
              {
                opacity:
                  pressed || !value.trim() || value.trim() === initialValue ? 0.6 : 1,
              },
            ]}>
            <ThemedText style={{ color: colors.tint, fontWeight: '600' }}>Rename</ThemedText>
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
});
