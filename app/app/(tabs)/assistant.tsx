import { StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Colors, Spacing, Type } from '@/constants/theme';
import { useColorScheme } from '@/hooks/use-color-scheme';

export default function AssistantScreen() {
  const colorScheme = useColorScheme() ?? 'light';
  const colors = Colors[colorScheme];

  return (
    <ThemedView style={styles.container}>
      <View style={styles.content}>
        <ThemedText style={[Type.section, { color: colors.text, textAlign: 'center' }]}>
          Assistant
        </ThemedText>
        <ThemedText style={[Type.body, { color: colors.muted, textAlign: 'center' }]}>
          Coming soon — chat-based instructions, auto-tagging, and AI cleanup tools.
        </ThemedText>
      </View>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  content: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: Spacing.xl,
    gap: Spacing.md,
  },
});
