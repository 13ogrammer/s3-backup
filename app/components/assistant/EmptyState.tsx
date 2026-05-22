import { useRouter } from 'expo-router';
import { Pressable, StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { IconSymbol } from '@/components/ui/icon-symbol';
import { Colors, Spacing, Type } from '@/constants/theme';
import { useColorScheme } from '@/hooks/use-color-scheme';
import type { SavedProvider } from '@/lib/assistantConfig';

type Props = {
  provider: SavedProvider | null;
};

export function EmptyState({ provider }: Props) {
  const colorScheme = useColorScheme() ?? 'light';
  const colors = Colors[colorScheme];
  const router = useRouter();

  const { title, body } = (() => {
    if (!provider) {
      return {
        title: 'Assistant needs a provider',
        body: 'Add an OpenAI-compatible provider in Settings — OpenRouter, Ollama Cloud, Ollama Local, or any other endpoint.',
      };
    }
    if (!provider.model.trim()) {
      return {
        title: `${provider.name} needs a model`,
        body: 'Open Settings and set a model name on the active provider — e.g. a tool-capable Llama or Qwen variant.',
      };
    }
    const isLocal = /^https?:\/\/(localhost|127\.|192\.168\.|10\.|172\.)/i.test(
      provider.baseUrl,
    );
    if (!isLocal && !provider.apiKey?.trim()) {
      return {
        title: `${provider.name} needs an API key`,
        body: 'Open Settings and paste an API key for this provider, or pick a different provider.',
      };
    }
    return {
      title: 'Assistant is not ready yet',
      body: 'Open Settings to finish configuring the active provider.',
    };
  })();

  return (
    <View style={styles.container}>
      <IconSymbol name="sparkles" size={48} color={colors.icon} />
      <ThemedText style={[Type.section, { color: colors.text, textAlign: 'center', marginTop: Spacing.lg }]}>
        {title}
      </ThemedText>
      <ThemedText style={[Type.body, { color: colors.muted, textAlign: 'center', marginTop: Spacing.sm }]}>
        {body}
      </ThemedText>
      <Pressable
        onPress={() => router.push('/settings')}
        accessibilityRole="button"
        style={({ pressed }) => [
          styles.button,
          { backgroundColor: colors.tint, opacity: pressed ? 0.7 : 1 },
        ]}>
        <ThemedText style={[Type.bodyStrong, { color: colors.onAccent }]}>Open Settings</ThemedText>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: Spacing.xl,
  },
  button: {
    marginTop: Spacing.xl,
    paddingHorizontal: Spacing.xl,
    paddingVertical: 14,
    borderRadius: 999,
    alignItems: 'center',
  },
});
