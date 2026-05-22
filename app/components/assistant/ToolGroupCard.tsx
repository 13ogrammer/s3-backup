import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { IconSymbol } from '@/components/ui/icon-symbol';
import { Colors, Radius, Shadow, Spacing, Type } from '@/constants/theme';
import { useColorScheme } from '@/hooks/use-color-scheme';

import { ToolCallCard } from './ToolCallCard';
import { TypingDots } from './TypingDots';

export type ToolEntry = {
  id: string;
  name: string;
  input: unknown;
  status: 'pending' | 'ok' | 'error';
  result?: unknown;
  errorMessage?: string;
};

type Props = {
  tools: ToolEntry[];
};

export function ToolGroupCard({ tools }: Props) {
  const colorScheme = useColorScheme() ?? 'light';
  const colors = Colors[colorScheme];
  const [expanded, setExpanded] = useState(false);

  const pending = tools.filter((t) => t.status === 'pending').length;
  const errored = tools.filter((t) => t.status === 'error').length;
  const completed = tools.length - pending;

  let summary: string;
  if (pending > 0) {
    summary = tools.length === 1 ? 'Running tool' : `Running ${tools.length} tools`;
  } else if (errored > 0) {
    summary =
      tools.length === 1
        ? '1 tool · error'
        : `${tools.length} tools · ${errored} error${errored === 1 ? '' : 's'}`;
  } else {
    summary = tools.length === 1 ? 'Used 1 tool' : `Used ${tools.length} tools`;
  }

  const summaryColor =
    pending > 0 ? colors.muted : errored > 0 ? colors.danger : colors.text;

  return (
    <View style={[styles.container, { backgroundColor: colors.surfaceMuted }, Shadow.card]}>
      <Pressable
        onPress={() => setExpanded((v) => !v)}
        accessibilityRole="button"
        accessibilityLabel={expanded ? 'Collapse tool details' : 'Expand tool details'}
        style={({ pressed }) => [styles.header, { opacity: pressed ? 0.7 : 1 }]}>
        <IconSymbol
          name="chevron.left.forwardslash.chevron.right"
          size={14}
          color={colors.icon}
        />
        <ThemedText style={[Type.label, { color: summaryColor, flex: 1 }]}>
          {summary}
        </ThemedText>
        {pending > 0 ? (
          <TypingDots color={colors.muted} />
        ) : (
          <ThemedText style={[Type.meta, { color: colors.muted }]}>
            {completed}/{tools.length}
          </ThemedText>
        )}
        <IconSymbol
          name={expanded ? 'chevron.left' : 'chevron.right'}
          size={14}
          color={colors.muted}
        />
      </Pressable>

      {expanded && (
        <View style={[styles.body, { borderTopColor: colors.border }]}>
          {tools.map((t) => (
            <ToolCallCard
              key={t.id}
              name={t.name}
              input={t.input}
              status={t.status}
              result={t.result}
              errorMessage={t.errorMessage}
            />
          ))}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    marginHorizontal: Spacing.lg,
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
    paddingVertical: Spacing.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
});
