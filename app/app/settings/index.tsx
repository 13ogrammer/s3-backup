import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Colors, Radius, Spacing, Type } from '@/constants/theme';
import { useColorScheme } from '@/hooks/use-color-scheme';
import { getActiveProvider, isProviderUsable } from '@/lib/assistantConfig';
import { loadAutoBackupState } from '@/lib/autoBackupState';
import { loadConfig } from '@/lib/config';

export default function SettingsIndex() {
  const colorScheme = useColorScheme() ?? 'light';
  const colors = Colors[colorScheme];
  const router = useRouter();

  const [connectionReady, setConnectionReady] = useState(false);
  const [autoBackupReady, setAutoBackupReady] = useState(false);
  const [aiReady, setAiReady] = useState(false);

  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      Promise.all([loadConfig(), loadAutoBackupState(), getActiveProvider()])
        .then(([cfg, autoState, provider]) => {
          if (cancelled) return;
          setConnectionReady(cfg !== null);
          setAutoBackupReady(autoState.enabled);
          setAiReady(isProviderUsable(provider));
        })
        .catch(() => {});
      return () => {
        cancelled = true;
      };
    }, []),
  );

  function renderTrailing(ready: boolean) {
    return (
      <View style={styles.navRowRight}>
        {ready ? (
          <Ionicons name="checkmark-circle" size={20} color={colors.success} />
        ) : null}
        <Ionicons name="chevron-forward" size={18} color={colors.muted} />
      </View>
    );
  }

  return (
    <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
      <ThemedView style={styles.container}>
        <View style={[styles.card, { backgroundColor: colors.surface }]}>
          <Pressable
            accessibilityRole="button"
            onPress={() => router.push('/settings/connection')}
            style={({ pressed }) => [
              styles.navRow,
              {
                borderBottomWidth: StyleSheet.hairlineWidth,
                borderBottomColor: colors.border,
                opacity: pressed ? 0.7 : 1,
              },
            ]}>
            <View style={styles.navRowLeft}>
              <Ionicons name="wifi" size={20} color={colors.tint} style={styles.navRowIcon} />
              <ThemedText style={[Type.body, { color: colors.text }]}>Connection</ThemedText>
            </View>
            {renderTrailing(connectionReady)}
          </Pressable>

          <Pressable
            accessibilityRole="button"
            onPress={() => router.push('/settings/auto-backup')}
            style={({ pressed }) => [
              styles.navRow,
              {
                borderBottomWidth: StyleSheet.hairlineWidth,
                borderBottomColor: colors.border,
                opacity: pressed ? 0.7 : 1,
              },
            ]}>
            <View style={styles.navRowLeft}>
              <Ionicons
                name="cloud-upload-outline"
                size={20}
                color={colors.tint}
                style={styles.navRowIcon}
              />
              <ThemedText style={[Type.body, { color: colors.text }]}>Auto-backup</ThemedText>
            </View>
            {renderTrailing(autoBackupReady)}
          </Pressable>

          <Pressable
            accessibilityRole="button"
            onPress={() => router.push('/settings/ai')}
            style={({ pressed }) => [
              styles.navRow,
              { opacity: pressed ? 0.7 : 1 },
            ]}>
            <View style={styles.navRowLeft}>
              <Ionicons
                name="sparkles"
                size={20}
                color={colors.tint}
                style={styles.navRowIcon}
              />
              <ThemedText style={[Type.body, { color: colors.text }]}>AI</ThemedText>
            </View>
            {renderTrailing(aiReady)}
          </Pressable>
        </View>

        <View style={[styles.card, { backgroundColor: colors.surface }]}>
          <Pressable
            accessibilityRole="button"
            onPress={() => router.push('/about')}
            style={({ pressed }) => [styles.navRow, { opacity: pressed ? 0.7 : 1 }]}>
            <ThemedText style={[Type.body, { color: colors.text }]}>About</ThemedText>
            <Ionicons name="chevron-forward" size={18} color={colors.muted} />
          </Pressable>
        </View>
      </ThemedView>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scroll: { flexGrow: 1 },
  container: { flex: 1, padding: Spacing.lg, gap: Spacing.md },
  card: {
    borderRadius: Radius.lg,
    overflow: 'hidden',
  },
  navRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.md,
  },
  navRowLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
  },
  navRowRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
  },
  navRowIcon: { width: 20 },
});
