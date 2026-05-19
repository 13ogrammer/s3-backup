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
  initialValue: string;
  onCancel: () => void;
  onSubmit: (query: string) => void;
};

export function SearchModal({ visible, initialValue, onCancel, onSubmit }: Props) {
  const colorScheme = useColorScheme() ?? 'light';
  const colors = Colors[colorScheme];

  const [value, setValue] = useState(initialValue);

  useEffect(() => {
    if (visible) setValue(initialValue);
  }, [visible, initialValue]);

  function submit() {
    onSubmit(value.trim());
  }

  return (
    <KeyboardAvoidingView
      style={StyleSheet.absoluteFill}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      pointerEvents={visible ? 'auto' : 'none'}>
      <ModalCard visible={visible} onRequestClose={onCancel} title="Search">
        <TextInput
          value={value}
          onChangeText={setValue}
          placeholder="Search in this folder"
          placeholderTextColor={colors.muted}
          autoCapitalize="none"
          autoCorrect={false}
          autoFocus
          onSubmitEditing={submit}
          returnKeyType="search"
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
            style={({ pressed }) => [styles.button, { opacity: pressed ? 0.6 : 1 }]}>
            <ThemedText style={{ color: colors.tint, fontWeight: '600' }}>Search</ThemedText>
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
