import { Ionicons } from '@expo/vector-icons';
import * as Application from 'expo-application';
import * as WebBrowser from 'expo-web-browser';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { CHANGELOG_ENTRIES } from '@/constants/changelog';
import { GITHUB_REPO_URL, ISSUES_URL, LICENSE_URL } from '@/constants/links';
import { Colors, Radius, Spacing, Type } from '@/constants/theme';
import { useColorScheme } from '@/hooks/use-color-scheme';
import { getAppVersion } from '@/lib/version';

export default function AboutScreen() {
  const colorScheme = useColorScheme() ?? 'light';
  const colors = Colors[colorScheme];

  function openUrl(url: string) {
    WebBrowser.openBrowserAsync(url);
  }

  return (
    <ThemedView style={styles.container}>
      <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
        {/* Identity card */}
        <View style={[styles.card, { backgroundColor: colors.surface }]}>
          <ThemedText style={[Type.title, { color: colors.text }]}>S3 Backup</ThemedText>
          <ThemedText style={[Type.body, { color: colors.muted, marginTop: Spacing.xs }]}>
            Back up your phone photos and videos to your own private S3 bucket. Your AWS credentials
            never live on your phone, your photo bytes never traverse the backend, and your data
            stays in your bucket.
          </ThemedText>

          <View style={[styles.divider, { backgroundColor: colors.divider }]} />

          <Pressable
            accessibilityRole="link"
            onPress={() => openUrl(GITHUB_REPO_URL)}
            style={({ pressed }) => [styles.linkRow, { opacity: pressed ? 0.7 : 1 }]}>
            <Ionicons name="logo-github" size={18} color={colors.tint} />
            <ThemedText style={[Type.body, styles.linkText, { color: colors.tint }]}>
              GitHub repository
            </ThemedText>
            <Ionicons name="chevron-forward" size={16} color={colors.muted} />
          </Pressable>

          <Pressable
            accessibilityRole="link"
            onPress={() => openUrl(LICENSE_URL)}
            style={({ pressed }) => [styles.linkRow, { opacity: pressed ? 0.7 : 1 }]}>
            <Ionicons name="document-text-outline" size={18} color={colors.tint} />
            <ThemedText style={[Type.body, styles.linkText, { color: colors.tint }]}>
              MIT License
            </ThemedText>
            <Ionicons name="chevron-forward" size={16} color={colors.muted} />
          </Pressable>

          <Pressable
            accessibilityRole="link"
            onPress={() => openUrl(ISSUES_URL)}
            style={({ pressed }) => [styles.linkRow, { opacity: pressed ? 0.7 : 1 }]}>
            <Ionicons name="bug-outline" size={18} color={colors.tint} />
            <ThemedText style={[Type.body, styles.linkText, { color: colors.tint }]}>
              Report an issue
            </ThemedText>
            <Ionicons name="chevron-forward" size={16} color={colors.muted} />
          </Pressable>
        </View>

        {/* Version card */}
        <View style={[styles.card, { backgroundColor: colors.surface }]}>
          <ThemedText style={[Type.bodyStrong, { color: colors.text }]}>Version</ThemedText>
          <View style={styles.versionRow}>
            <ThemedText style={[Type.body, { color: colors.muted }]}>App version</ThemedText>
            <ThemedText style={[Type.body, { color: colors.text }]}>{getAppVersion()}</ThemedText>
          </View>
          <View style={styles.versionRow}>
            <ThemedText style={[Type.body, { color: colors.muted }]}>Build</ThemedText>
            <ThemedText style={[Type.body, { color: colors.text }]}>
              {Application.nativeBuildVersion ?? '—'}
            </ThemedText>
          </View>
        </View>

        {/* Changelog card */}
        <View style={[styles.card, { backgroundColor: colors.surface }]}>
          <ThemedText style={[Type.bodyStrong, { color: colors.text }]}>Changelog</ThemedText>
          {CHANGELOG_ENTRIES.map((entry) => (
            <View key={entry.version} style={styles.changelogEntry}>
              <ThemedText style={[Type.label, styles.changelogHeader, { color: colors.text }]}>
                v{entry.version} · {entry.date}
              </ThemedText>
              {entry.notes.map((note, i) => (
                <View key={i} style={styles.bulletRow}>
                  <ThemedText style={[Type.body, { color: colors.muted }]}>{'•'}</ThemedText>
                  <ThemedText style={[Type.body, styles.bulletText, { color: colors.muted }]}>
                    {note}
                  </ThemedText>
                </View>
              ))}
            </View>
          ))}
        </View>
      </ScrollView>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  scroll: { padding: Spacing.lg, gap: Spacing.md, paddingBottom: Spacing.xxl },
  card: {
    padding: Spacing.lg,
    borderRadius: Radius.lg,
    gap: Spacing.sm,
  },
  divider: { height: 1, marginVertical: Spacing.xs },
  linkRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    paddingVertical: Spacing.xs,
  },
  linkText: { flex: 1 },
  versionRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  changelogEntry: { gap: Spacing.xs, marginTop: Spacing.xs },
  changelogHeader: { fontWeight: '600' },
  bulletRow: {
    flexDirection: 'row',
    gap: Spacing.sm,
    paddingLeft: Spacing.xs,
  },
  bulletText: { flex: 1 },
});
