import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { IconSymbol } from '@/components/ui/icon-symbol';
import { Colors, Radius, Shadow, Spacing, Type } from '@/constants/theme';
import { useColorScheme } from '@/hooks/use-color-scheme';

type Props = {
  name: string;
  input: unknown;
  status: 'pending' | 'ok' | 'error';
  result?: unknown;
  errorMessage?: string;
};

export function ToolCallCard({ name, input, status, result, errorMessage }: Props) {
  const colorScheme = useColorScheme() ?? 'light';
  const colors = Colors[colorScheme];
  const [expanded, setExpanded] = useState(false);

  const statusColor =
    status === 'pending' ? colors.muted : status === 'ok' ? colors.tint : colors.danger;
  const statusLabel =
    status === 'pending' ? 'Running…' : status === 'ok' ? 'Done' : 'Error';

  return (
    <View style={[styles.container, { backgroundColor: colors.surfaceMuted }, Shadow.card]}>
      <Pressable
        onPress={() => setExpanded((v) => !v)}
        accessibilityRole="button"
        accessibilityLabel={expanded ? 'Collapse tool call' : 'Expand tool call'}
        style={({ pressed }) => [styles.header, { opacity: pressed ? 0.7 : 1 }]}>
        <IconSymbol name="chevron.left.forwardslash.chevron.right" size={14} color={colors.icon} />
        <ThemedText style={[Type.label, { color: colors.text, flex: 1 }]}>{name}</ThemedText>
        <ThemedText style={[Type.meta, { color: statusColor }]}>{statusLabel}</ThemedText>
        <IconSymbol
          name={expanded ? 'chevron.left' : 'chevron.right'}
          size={14}
          color={colors.muted}
        />
      </Pressable>

      {expanded && (
        <View style={[styles.body, { borderTopColor: colors.border }]}>
          <ThemedText style={[Type.meta, { color: colors.muted, marginBottom: Spacing.xs }]}>
            Input
          </ThemedText>
          <ThemedText style={[styles.code, { color: colors.text, backgroundColor: colors.surface }]}>
            {JSON.stringify(input, null, 2)}
          </ThemedText>

          {status !== 'pending' && (
            <>
              <ThemedText
                style={[Type.meta, { color: colors.muted, marginTop: Spacing.sm, marginBottom: Spacing.xs }]}>
                Result
              </ThemedText>
              <ThemedText
                style={[
                  styles.code,
                  {
                    color: status === 'error' ? colors.danger : colors.text,
                    backgroundColor: colors.surface,
                  },
                ]}>
                {status === 'error'
                  ? (errorMessage ?? 'Unknown error')
                  : summarise(result)}
              </ThemedText>
            </>
          )}
        </View>
      )}
    </View>
  );
}

function summarise(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  const json = JSON.stringify(value, null, 2);
  // Cap display at 2000 chars to keep the card tidy.
  if (json.length > 2000) return json.slice(0, 2000) + '\n… (truncated)';
  return json;
}

const styles = StyleSheet.create({
  container: {
    marginHorizontal: Spacing.md,
    marginBottom: Spacing.sm,
    borderRadius: Radius.md,
    overflow: 'hidden',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    padding: Spacing.md,
  },
  body: {
    padding: Spacing.md,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  code: {
    fontFamily: 'monospace',
    fontSize: 12,
    lineHeight: 18,
    padding: Spacing.sm,
    borderRadius: Radius.sm,
  },
});
