import { Ionicons } from '@expo/vector-icons';
import * as MediaLibrary from 'expo-media-library';
import { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  AppState,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  View,
} from 'react-native';

import {
  AutoBackupModeModal,
  type AutoBackupModeModalConfirmResult,
} from '@/components/auto-backup-mode-modal';
import { AutoBackupPrefixModal } from '@/components/auto-backup-prefix-modal';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { useAlert } from '@/components/ui/alert-provider';
import { Colors, Radius, Spacing, Type } from '@/constants/theme';
import { useColorScheme } from '@/hooks/use-color-scheme';
import {
  DEFAULT_AUTO_BACKUP_STATE,
  isAutoBackupRunningFresh,
  loadAutoBackupState,
  saveAutoBackupState,
  type AutoBackupState,
  type BackupMode,
} from '@/lib/autoBackupState';
import {
  registerAutoBackup,
  runAutoBackupTick,
  unregisterAutoBackup,
} from '@/lib/autoBackupTask';
import { loadConfig } from '@/lib/config';

export default function AutoBackupScreen() {
  const colorScheme = useColorScheme() ?? 'light';
  const colors = Colors[colorScheme];
  const { showAlert } = useAlert();

  const [autoBackupState, setAutoBackupState] = useState<AutoBackupState>(DEFAULT_AUTO_BACKUP_STATE);
  const [backingUpNow, setBackingUpNow] = useState<boolean>(false);
  const [hasConfig, setHasConfig] = useState(false);
  const [mediaPermStatus, setMediaPermStatus] =
    useState<MediaLibrary.PermissionStatus | null>(null);
  const [modeModalVisible, setModeModalVisible] = useState(false);
  const [modeModalIsFirstEnable, setModeModalIsFirstEnable] = useState(false);
  const [prefixModalVisible, setPrefixModalVisible] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([loadConfig(), loadAutoBackupState()]).then(([cfg, autoState]) => {
      setHasConfig(cfg !== null);
      setAutoBackupState(autoState);
      setLoading(false);
    });
  }, []);

  // Refresh permission status on mount and whenever the app returns from
  // background (covers the case where the user toggled it in system Settings).
  // Also refreshes auto-backup state so "Last ran" updates after a background tick.
  useEffect(() => {
    const refresh = () => {
      MediaLibrary.getPermissionsAsync()
        .then((res) => setMediaPermStatus(res.status))
        .catch(() => {});
      loadAutoBackupState().then(setAutoBackupState).catch(() => {});
    };
    refresh();
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') refresh();
    });
    return () => sub.remove();
  }, []);

  async function onToggleAutoEnabled(value: boolean) {
    if (value) {
      const { status } = await MediaLibrary.requestPermissionsAsync();
      setMediaPermStatus(status);
      if (status !== 'granted') {
        showAlert(
          'Photo access needed',
          'Auto-backup needs access to your photos and videos. Grant access in Settings, then try again.',
        );
        return;
      }
      setModeModalIsFirstEnable(true);
      setModeModalVisible(true);
    } else {
      await unregisterAutoBackup();
      const next = await saveAutoBackupState({ enabled: false });
      setAutoBackupState(next);
    }
  }

  async function onModeChosenFirstEnable(result: {
    mode: BackupMode;
    customStartDate: number | null;
    prefix: string;
  }) {
    setModeModalVisible(false);
    const lastCreatedAt =
      result.mode === 'all'
        ? null
        : result.mode === 'newOnly'
          ? Date.now()
          : result.customStartDate;

    // Atomic write: all 5 fields in a single save so the first tick sees the
    // correct prefix and doesn't land under the stale default.
    const next = await saveAutoBackupState({
      enabled: true,
      backupMode: result.mode,
      customStartDate: result.customStartDate,
      lastCreatedAt,
      prefix: result.prefix,
    });
    setAutoBackupState(next);
    await registerAutoBackup();
    setImmediate(() => { runAutoBackupTick().catch(console.warn); });
  }

  function onModeChooserCancel() {
    setModeModalVisible(false);
    // In first-enable context: toggle returns to OFF (no state was written).
    // In post-enable context: modal closes, nothing changes.
  }

  function onModeConfirm(result: AutoBackupModeModalConfirmResult) {
    if (modeModalIsFirstEnable) {
      onModeChosenFirstEnable(result);
    } else {
      onModeSwitched(result);
    }
  }

  function onTapModeRow() {
    setModeModalIsFirstEnable(false);
    setModeModalVisible(true);
  }

  async function onModeSwitched(result: {
    mode: BackupMode;
    customStartDate: number | null;
    prefix: string; // includePrefix is false on this path; result.prefix is the echoed initialPrefix and is intentionally ignored.
  }) {
    setModeModalVisible(false);
    const currentMode = autoBackupState.backupMode;

    if (
      result.mode === currentMode &&
      !(result.mode === 'fromDate' && currentMode === 'fromDate')
    ) {
      return;
    }
    if (
      result.mode === 'fromDate' &&
      currentMode === 'fromDate' &&
      result.customStartDate === autoBackupState.customStartDate
    ) {
      return;
    }

    function doSwitch() {
      const lastCreatedAt =
        result.mode === 'all'
          ? null
          : result.mode === 'newOnly'
            ? Date.now()
            : result.customStartDate;

      saveAutoBackupState({
        backupMode: result.mode,
        customStartDate: result.customStartDate,
        lastCreatedAt,
      }).then((next) => setAutoBackupState(next)).catch(console.warn);
    }

    const pickedDate = result.customStartDate;
    const pickedDateLabel = pickedDate != null
      ? new Date(pickedDate).toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' })
      : '';

    type ConfirmSpec = { title: string; body: string };

    function getConfirmSpec(): ConfirmSpec | null {
      if (result.mode === currentMode && result.mode !== 'fromDate') return null;

      if (result.mode === 'all') {
        return {
          title: 'Back up everything?',
          body: 'This will queue your entire photo library for backup. Continue?',
        };
      }
      if (result.mode === 'newOnly') {
        return {
          title: 'New media only?',
          body: "Stop backing up older media you haven't uploaded yet?",
        };
      }
      if (pickedDate != null) {
        const cursor = autoBackupState.lastCreatedAt ?? 0;
        if (pickedDate < cursor) {
          return {
            title: `Re-queue from ${pickedDateLabel}?`,
            body: `This will re-queue media created since ${pickedDateLabel}.`,
          };
        }
        return {
          title: `Start from ${pickedDateLabel}?`,
          body: `Skip older media and start from ${pickedDateLabel}?`,
        };
      }
      return null;
    }

    const spec = getConfirmSpec();
    if (!spec) {
      doSwitch();
      return;
    }

    showAlert(spec.title, spec.body, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Confirm', style: 'destructive', onPress: doSwitch },
    ]);
  }

  async function onFixMediaPermission() {
    const { status } = await MediaLibrary.requestPermissionsAsync();
    setMediaPermStatus(status);
    if (status !== 'granted') {
      Linking.openSettings().catch(() => {
        showAlert(
          'Open Settings',
          'Could not open system Settings. Please grant photo access manually.',
        );
      });
    }
  }

  async function onSavePrefix(sanitized: string) {
    setPrefixModalVisible(false);
    const next = await saveAutoBackupState({ prefix: sanitized });
    setAutoBackupState(next);
  }

  async function onToggleWifiOnly(value: boolean) {
    const next = await saveAutoBackupState({ wifiOnly: value });
    setAutoBackupState(next);
  }

  async function onBackupNow() {
    setBackingUpNow(true);
    try {
      await runAutoBackupTick();
    } catch (err) {
      console.warn(err);
    } finally {
      setBackingUpNow(false);
      loadAutoBackupState().then(setAutoBackupState).catch(() => {});
    }
  }

  const backupNowDisabled = backingUpNow || isAutoBackupRunningFresh(autoBackupState);

  if (loading) {
    return (
      <ThemedView style={[styles.container, styles.center]}>
        <ActivityIndicator />
      </ThemedView>
    );
  }

  return (
    <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
      <ThemedView style={styles.container}>
        {!hasConfig && (
          <ThemedText style={[styles.hint, { color: colors.muted }]}>
            Configure your backend in Connection before enabling auto-backup.
          </ThemedText>
        )}

        <View style={[styles.card, { backgroundColor: colors.surface, gap: 0, padding: 0 }]}>
          <View
            style={[
              styles.toggleRow,
              { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
            ]}>
            <View style={{ flex: 1 }}>
              <ThemedText style={[Type.body, { color: colors.text }]}>Enable</ThemedText>
              <ThemedText style={[Type.meta, { color: colors.muted }]}>
                Automatically back up new photos and videos in the background
              </ThemedText>
            </View>
            <Switch
              value={autoBackupState.enabled}
              onValueChange={onToggleAutoEnabled}
              disabled={!hasConfig}
              trackColor={{ false: colors.border, true: colors.tint }}
              thumbColor={colors.onAccent}
            />
          </View>

          {autoBackupState.enabled &&
            mediaPermStatus !== null &&
            mediaPermStatus !== 'granted' && (
              <Pressable
                onPress={onFixMediaPermission}
                style={({ pressed }) => [
                  styles.toggleRow,
                  {
                    backgroundColor: colors.dangerSoft,
                    borderBottomWidth: StyleSheet.hairlineWidth,
                    borderBottomColor: colors.border,
                    opacity: pressed ? 0.7 : 1,
                  },
                ]}>
                <Ionicons name="alert-circle" size={20} color={colors.danger} />
                <View style={{ flex: 1 }}>
                  <ThemedText style={[Type.body, { color: colors.danger }]}>
                    Photo access needed
                  </ThemedText>
                  <ThemedText style={[Type.meta, { color: colors.danger }]}>
                    Auto-backup can&apos;t run without photo access. Tap to fix.
                  </ThemedText>
                </View>
                <Ionicons name="chevron-forward" size={18} color={colors.danger} />
              </Pressable>
            )}

          {autoBackupState.enabled && (
            <Pressable
              onPress={onTapModeRow}
              style={({ pressed }) => [
                styles.toggleRow,
                {
                  borderBottomWidth: StyleSheet.hairlineWidth,
                  borderBottomColor: colors.border,
                  opacity: pressed ? 0.7 : 1,
                },
              ]}>
              <View style={{ flex: 1 }}>
                <ThemedText style={[Type.body, { color: colors.text }]}>
                  {autoBackupState.backupMode === 'all'
                    ? 'Backing up: Everything'
                    : autoBackupState.backupMode === 'newOnly'
                      ? 'Backing up: New media only'
                      : `Backing up: Since ${
                          autoBackupState.customStartDate != null
                            ? new Date(autoBackupState.customStartDate).toLocaleDateString(
                                undefined,
                                { day: '2-digit', month: 'short', year: 'numeric' },
                              )
                            : '—'
                        }`}
                </ThemedText>
                {autoBackupState.lastRanAt != null && (
                  <ThemedText style={[Type.meta, { color: colors.muted }]}>
                    {`Last ran ${formatRelativeTime(autoBackupState.lastRanAt)}`}
                  </ThemedText>
                )}
              </View>
              <Ionicons name="chevron-forward" size={18} color={colors.muted} />
            </Pressable>
          )}

          {autoBackupState.enabled && (
            <Pressable
              onPress={() => setPrefixModalVisible(true)}
              style={({ pressed }) => [
                styles.toggleRow,
                {
                  borderBottomWidth: StyleSheet.hairlineWidth,
                  borderBottomColor: colors.border,
                  opacity: pressed ? 0.7 : 1,
                },
              ]}>
              <View style={{ flex: 1 }}>
                <ThemedText style={[Type.body, { color: colors.text }]}>
                  Folder prefix
                </ThemedText>
                <ThemedText style={[Type.meta, { color: colors.muted }]}>
                  {autoBackupState.prefix === '' ? '(bucket root)' : autoBackupState.prefix}
                </ThemedText>
              </View>
              <Ionicons name="chevron-forward" size={18} color={colors.muted} />
            </Pressable>
          )}

          <View style={styles.toggleRow}>
            <View style={{ flex: 1 }}>
              <ThemedText style={[Type.body, { color: colors.text }]}>Wi-Fi only</ThemedText>
              <ThemedText style={[Type.meta, { color: colors.muted }]}>
                Skip backup ticks on cellular to avoid data charges
              </ThemedText>
            </View>
            <Switch
              value={autoBackupState.wifiOnly}
              onValueChange={onToggleWifiOnly}
              disabled={!hasConfig}
              trackColor={{ false: colors.border, true: colors.tint }}
              thumbColor={colors.onAccent}
            />
          </View>

          {autoBackupState.enabled && (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Back up now"
              accessibilityState={{ disabled: backupNowDisabled }}
              disabled={backupNowDisabled}
              onPress={onBackupNow}
              style={[
                styles.toggleRow,
                {
                  borderTopWidth: StyleSheet.hairlineWidth,
                  borderTopColor: colors.border,
                  opacity: backupNowDisabled ? 0.5 : 1,
                },
              ]}>
              <Ionicons name="cloud-upload-outline" size={20} color={colors.tint} />
              <View style={{ flex: 1 }}>
                <ThemedText style={[Type.body, { color: colors.tint, fontWeight: '600' }]}>
                  Back up now
                </ThemedText>
              </View>
            </Pressable>
          )}
        </View>
      </ThemedView>

      <AutoBackupModeModal
        visible={modeModalVisible}
        initialMode={modeModalIsFirstEnable ? undefined : autoBackupState.backupMode}
        initialCustomDate={modeModalIsFirstEnable ? null : autoBackupState.customStartDate}
        includePrefix={modeModalIsFirstEnable}
        initialPrefix={autoBackupState.prefix}
        onConfirm={onModeConfirm}
        onCancel={onModeChooserCancel}
      />

      <AutoBackupPrefixModal
        visible={prefixModalVisible}
        initialValue={autoBackupState.prefix}
        onSave={onSavePrefix}
        onCancel={() => setPrefixModalVisible(false)}
      />
    </ScrollView>
  );
}

// Returns a human-readable relative time string for display (e.g. "2 hours ago").
function formatRelativeTime(ms: number): string {
  const diff = Date.now() - ms;
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: Spacing.lg, gap: Spacing.md },
  center: { alignItems: 'center', justifyContent: 'center' },
  scroll: { flexGrow: 1 },
  hint: { fontSize: 14, marginBottom: Spacing.xs, marginTop: Spacing.xs },
  card: {
    borderRadius: Radius.lg,
    overflow: 'hidden',
  },
  toggleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.md,
    gap: Spacing.md,
  },
});
