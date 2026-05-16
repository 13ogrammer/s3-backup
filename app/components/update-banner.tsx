import * as WebBrowser from 'expo-web-browser';
import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Colors, Radius, Spacing, Type } from '@/constants/theme';
import { useColorScheme } from '@/hooks/use-color-scheme';
import {
  fetchVersionManifest,
  getAppVersion,
  semverLt,
  type VersionManifest,
} from '@/lib/version';

export function UpdateBanner() {
  const [manifest, setManifest] = useState<VersionManifest | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const colorScheme = useColorScheme() ?? 'light';
  const colors = Colors[colorScheme];

  useEffect(() => {
    fetchVersionManifest().then(setManifest);
  }, []);

  if (!manifest) return null;

  const appVersion = getAppVersion();
  const isOutdated = semverLt(appVersion, manifest.latestNativeVersion);

  if (!isOutdated) return null;
  if (dismissed) return null;

  return (
    <View
      style={[
        styles.banner,
        {
          backgroundColor: colors.accentSoft,
          borderBottomColor: colors.border,
        },
      ]}>
      <ThemedText style={[styles.bannerText, { color: colors.text }]}>
        A new version is available.
      </ThemedText>
      <View style={styles.bannerActions}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Download update"
          onPress={() => WebBrowser.openBrowserAsync(manifest.apkUrl)}
          style={({ pressed }) => [
            styles.downloadButton,
            { backgroundColor: colors.tint, opacity: pressed ? 0.7 : 1 },
          ]}>
          <ThemedText style={[styles.downloadButtonText, { color: colors.onAccent }]}>
            Download
          </ThemedText>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Dismiss update banner"
          onPress={() => setDismissed(true)}
          hitSlop={Spacing.sm}
          style={({ pressed }) => ({ opacity: pressed ? 0.5 : 1 })}>
          <ThemedText style={[styles.dismissText, { color: colors.text }]}>
            Later
          </ThemedText>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.sm,
    borderBottomWidth: 1,
  },
  bannerText: {
    ...Type.label,
    flex: 1,
  },
  bannerActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    marginLeft: Spacing.sm,
  },
  downloadButton: {
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.xs,
    borderRadius: Radius.pill,
  },
  downloadButtonText: {
    ...Type.label,
  },
  dismissText: {
    ...Type.label,
  },
});
