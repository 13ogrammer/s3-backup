import { Pressable, StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Colors, Radius, Spacing, Type } from '@/constants/theme';
import { useColorScheme } from '@/hooks/use-color-scheme';
import type { SavedProvider } from '@/lib/assistantConfig';

type Props = {
  provider: SavedProvider;
  onAcknowledge: () => void;
};

function isLocalLoopback(url: string): boolean {
  return /^https?:\/\/(localhost|127\.|192\.168\.|10\.|172\.)/i.test(url);
}

export function PrivacyNotice({ provider, onAcknowledge }: Props) {
  const colorScheme = useColorScheme() ?? 'light';
  const colors = Colors[colorScheme];

  const local = isLocalLoopback(provider.baseUrl);
  const message = local
    ? `When you chat with the Assistant, file and folder names from your S3 bucket are sent to ${provider.name} at ${provider.baseUrl}. Because that endpoint is local, the data stays on your network. No file contents are sent.`
    : `When you chat with the Assistant, file and folder names from your S3 bucket are sent to ${provider.name} to answer your questions. No file contents are sent. Your API key stays on this device.`;

  return (
    <View style={styles.overlay}>
      <View
        style={[
          styles.card,
          { backgroundColor: colors.accentSoft },
        ]}>
        <ThemedText style={[Type.bodyStrong, { color: colors.text }]}>Heads up</ThemedText>
        <ThemedText style={[Type.body, { color: colors.text, marginTop: Spacing.sm }]}>
          {message}
        </ThemedText>
        <Pressable
          onPress={onAcknowledge}
          accessibilityRole="button"
          style={({ pressed }) => [
            styles.button,
            { backgroundColor: colors.tint, opacity: pressed ? 0.7 : 1 },
          ]}>
          <ThemedText style={[Type.bodyStrong, { color: colors.onAccent }]}>Got it</ThemedText>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  overlay: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    padding: Spacing.lg,
  },
  card: {
    borderRadius: Radius.lg,
    padding: Spacing.lg,
  },
  button: {
    marginTop: Spacing.lg,
    paddingVertical: 12,
    borderRadius: Radius.md,
    alignItems: 'center',
  },
});
