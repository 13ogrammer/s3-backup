import { useRef } from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';

import { IconSymbol } from '@/components/ui/icon-symbol';
import { Colors, Radius, Spacing } from '@/constants/theme';
import { useColorScheme } from '@/hooks/use-color-scheme';

type Props = {
  value: string;
  onChangeText: (text: string) => void;
  onSend: () => void;
  onStop?: () => void;
  busy: boolean;
  disabled?: boolean;
  placeholder?: string;
};

export function ChatComposer({
  value,
  onChangeText,
  onSend,
  onStop,
  busy,
  disabled = false,
  placeholder = 'Ask about your S3 bucket…',
}: Props) {
  const colorScheme = useColorScheme() ?? 'light';
  const colors = Colors[colorScheme];
  const inputRef = useRef<TextInput>(null);

  const canSend = !busy && !disabled && value.trim().length > 0;
  const showStop = busy && !!onStop;

  return (
    <View style={[styles.container, { backgroundColor: colors.surface, borderTopColor: colors.border }]}>
      <TextInput
        ref={inputRef}
        value={value}
        onChangeText={onChangeText}
        onSubmitEditing={canSend ? onSend : undefined}
        placeholder={disabled ? 'Set up a provider in Settings to chat' : placeholder}
        placeholderTextColor={colors.muted}
        editable={!busy && !disabled}
        multiline
        returnKeyType="send"
        blurOnSubmit
        style={[
          styles.input,
          { color: colors.text, backgroundColor: colors.surfaceMuted },
        ]}
      />
      <Pressable
        onPress={showStop ? onStop : canSend ? onSend : undefined}
        disabled={!showStop && !canSend}
        accessibilityRole="button"
        accessibilityLabel={showStop ? 'Stop' : 'Send message'}
        style={({ pressed }) => [
          styles.sendButton,
          {
            backgroundColor: showStop
              ? colors.danger
              : canSend
                ? colors.tint
                : colors.surfaceMuted,
            opacity: pressed ? 0.7 : 1,
          },
        ]}>
        {showStop ? (
          <IconSymbol name="stop.fill" size={18} color={colors.onAccent} />
        ) : busy ? (
          <ActivityIndicator size="small" color={colors.onAccent} />
        ) : (
          <IconSymbol name="paperplane.fill" size={18} color={canSend ? colors.onAccent : colors.icon} />
        )}
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: Spacing.sm,
    padding: Spacing.md,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  input: {
    flex: 1,
    minHeight: 40,
    maxHeight: 120,
    borderRadius: Radius.md,
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm,
    fontSize: 16,
  },
  sendButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
