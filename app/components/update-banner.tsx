import * as WebBrowser from 'expo-web-browser';
import { useEffect, useState } from 'react';
import { Modal, Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ThemedText } from '@/components/themed-text';
import { Colors, Radius, Spacing, Type } from '@/constants/theme';
import { useColorScheme } from '@/hooks/use-color-scheme';
import {
  fetchVersionManifest,
  getAppVersion,
  semverLt,
  type VersionManifest,
} from '@/lib/version';

function useVersionCheck() {
  const [manifest, setManifest] = useState<VersionManifest | null>(null);

  useEffect(() => {
    fetchVersionManifest().then(setManifest);
  }, []);

  return manifest;
}

export function UpdateBanner() {
  const manifest = useVersionCheck();
  const [dismissed, setDismissed] = useState(false);
  const colorScheme = useColorScheme() ?? 'light';
  const colors = Colors[colorScheme];

  if (!manifest) return null;

  const appVersion = getAppVersion();
  const isBlocking = semverLt(appVersion, manifest.minSupportedVersion);
  const isOutdated = semverLt(appVersion, manifest.latestNativeVersion);

  // Blocking modal handles the UX when below minSupportedVersion.
  if (isBlocking) return null;
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

export function BlockingUpdateModal() {
  const manifest = useVersionCheck();
  const colorScheme = useColorScheme() ?? 'light';
  const colors = Colors[colorScheme];
  const insets = useSafeAreaInsets();

  if (!manifest) return null;

  const appVersion = getAppVersion();
  const isBlocking = semverLt(appVersion, manifest.minSupportedVersion);

  if (!isBlocking) return null;

  return (
    <Modal
      visible
      transparent={false}
      animationType="fade"
      statusBarTranslucent
      onRequestClose={() => {}}
    >
      <View
        style={[
          styles.modalContainer,
          {
            backgroundColor: colors.background,
            paddingTop: insets.top + Spacing.xl,
            paddingBottom: insets.bottom + Spacing.xl,
          },
        ]}>
        <ThemedText style={[styles.modalTitle, { color: colors.text }]}>
          Update required
        </ThemedText>
        <ThemedText style={[styles.modalBody, { color: colors.text }]}>
          This version of s3-backup is no longer supported. Please download
          the latest version to continue.
        </ThemedText>
        {manifest.releaseNotes ? (
          <View
            style={[styles.releaseNotesBox, { backgroundColor: colors.surface, borderColor: colors.border }]}>
            <ThemedText style={[styles.releaseNotesLabel, { color: colors.text }]}>
              What's new
            </ThemedText>
            <ThemedText style={[styles.releaseNotesText, { color: colors.text }]}>
              {manifest.releaseNotes}
            </ThemedText>
          </View>
        ) : null}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Download update"
          onPress={() => WebBrowser.openBrowserAsync(manifest.apkUrl)}
          style={({ pressed }) => [
            styles.modalButton,
            { backgroundColor: colors.tint, opacity: pressed ? 0.7 : 1 },
          ]}>
          <ThemedText style={[styles.modalButtonText, { color: colors.onAccent }]}>
            Download update
          </ThemedText>
        </Pressable>
      </View>
    </Modal>
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
  modalContainer: {
    flex: 1,
    paddingHorizontal: Spacing.xl,
    justifyContent: 'center',
    gap: Spacing.lg,
  },
  modalTitle: {
    ...Type.title,
  },
  modalBody: {
    ...Type.body,
  },
  releaseNotesBox: {
    borderWidth: 1,
    borderRadius: Radius.lg,
    padding: Spacing.lg,
    gap: Spacing.xs,
  },
  releaseNotesLabel: {
    ...Type.bodyStrong,
  },
  releaseNotesText: {
    ...Type.body,
  },
  modalButton: {
    borderRadius: Radius.pill,
    paddingVertical: Spacing.md,
    paddingHorizontal: Spacing.xl,
    alignItems: 'center',
    marginTop: Spacing.sm,
  },
  modalButtonText: {
    ...Type.bodyStrong,
  },
});
