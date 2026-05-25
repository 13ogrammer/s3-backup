import { StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Colors, Radius, Spacing, Type } from '@/constants/theme';
import { useColorScheme } from '@/hooks/use-color-scheme';
import { renderInlineMarkdown } from './inlineMarkdown';

type Props = {
  role: 'user' | 'assistant';
  text: string;
};

export function MessageBubble({ role, text }: Props) {
  const colorScheme = useColorScheme() ?? 'light';
  const colors = Colors[colorScheme];

  const isUser = role === 'user';

  return (
    <View style={[styles.row, isUser ? styles.rowUser : styles.rowAssistant]}>
      <View
        style={[
          styles.bubble,
          isUser
            ? { backgroundColor: colors.tint }
            : { backgroundColor: colors.surface },
        ]}>
        <ThemedText
          style={[
            Type.body,
            isUser ? { color: colors.onAccent } : { color: colors.text },
          ]}>
          {isUser
            ? text
            : renderInlineMarkdown(text, {
                color: colors.text,
                codeBg: colors.codeSurface,
              })}
        </ThemedText>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    paddingHorizontal: Spacing.lg,
    marginBottom: Spacing.sm,
  },
  rowUser: { alignItems: 'flex-end' },
  rowAssistant: { alignItems: 'flex-start' },
  bubble: {
    maxWidth: '80%',
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm,
    borderRadius: Radius.lg,
  },
});
