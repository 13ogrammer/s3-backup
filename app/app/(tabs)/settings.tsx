import { Ionicons } from '@expo/vector-icons';
import * as MediaLibrary from 'expo-media-library';
import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  AppState,
  KeyboardAvoidingView,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  TextInput,
  type TextInputProps,
  View,
} from 'react-native';

import {
  AutoBackupModeModal,
  type AutoBackupModeModalConfirmResult,
} from '@/components/auto-backup-mode-modal';
import { AutoBackupPrefixModal } from '@/components/auto-backup-prefix-modal';
import { QrScannerModal } from '@/components/qr-scanner-modal';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { useAlert } from '@/components/ui/alert-provider';
import { ModalCard } from '@/components/ui/modal-card';
import { Colors, Radius, Spacing, Type } from '@/constants/theme';
import { useColorScheme } from '@/hooks/use-color-scheme';
import { healthCheck } from '@/lib/api';
import {
  addProvider,
  bumpAssistantSessionResetVersion,
  getActiveProviderId,
  getProviders,
  removeProvider,
  setActiveProvider,
  updateProvider,
  type SavedProvider,
} from '@/lib/assistantConfig';
import { clearConfig, loadConfig, saveConfig } from '@/lib/config';
import { parseQrPayload } from '@/lib/qr-config';
import {
  loadAutoBackupState,
  saveAutoBackupState,
  DEFAULT_AUTO_BACKUP_STATE,
  type AutoBackupState,
  type BackupMode,
} from '@/lib/autoBackupState';
import {
  registerAutoBackup,
  unregisterAutoBackup,
  runAutoBackupTick,
} from '@/lib/autoBackupTask';

type EditorState =
  | { mode: 'add' }
  | { mode: 'edit'; id: string }
  | null;

type EditorDraft = {
  name: string;
  baseUrl: string;
  apiKey: string;
  model: string;
};

const EMPTY_DRAFT: EditorDraft = { name: '', baseUrl: '', apiKey: '', model: '' };

export default function SettingsScreen() {
  const colorScheme = useColorScheme() ?? 'light';
  const colors = Colors[colorScheme];
  const router = useRouter();
  const { showAlert } = useAlert();

  const [backendUrl, setBackendUrl] = useState('');
  const [bootstrapToken, setBootstrapToken] = useState('');
  const [providers, setProviders] = useState<SavedProvider[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [editor, setEditor] = useState<EditorState>(null);
  const [draft, setDraft] = useState<EditorDraft>(EMPTY_DRAFT);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [scannerVisible, setScannerVisible] = useState(false);
  const [autoBackupState, setAutoBackupState] = useState<AutoBackupState>(DEFAULT_AUTO_BACKUP_STATE);
  // Whether backend config exists — auto-backup toggles are disabled without it.
  const [hasConfig, setHasConfig] = useState(false);
  // Tracks MediaLibrary permission so we can surface a re-grant row if it's
  // revoked while auto-backup is enabled. `null` = not checked yet.
  const [mediaPermStatus, setMediaPermStatus] =
    useState<MediaLibrary.PermissionStatus | null>(null);

  // Mode chooser modal: shown on first-enable and when user taps the mode row.
  const [modeModalVisible, setModeModalVisible] = useState(false);
  // True when the chooser was opened for first-enable (vs. a mode switch).
  const [modeModalIsFirstEnable, setModeModalIsFirstEnable] = useState(false);
  // Prefix editor modal.
  const [prefixModalVisible, setPrefixModalVisible] = useState(false);

  useEffect(() => {
    Promise.all([loadConfig(), getProviders(), getActiveProviderId(), loadAutoBackupState()]).then(
      ([cfg, list, aid, autoState]) => {
        if (cfg) {
          setBackendUrl(cfg.backendUrl);
          setBootstrapToken(cfg.bootstrapToken);
          setHasConfig(true);
        }
        setProviders(list);
        setActiveId(aid ?? list[0]?.id ?? null);
        setAutoBackupState(autoState);
        setLoading(false);
      },
    );
  }, []);

  // Refresh permission status on mount and whenever the app returns from
  // background (covers the case where the user toggled it in system Settings).
  useEffect(() => {
    const refresh = () => {
      MediaLibrary.getPermissionsAsync()
        .then((res) => setMediaPermStatus(res.status))
        .catch(() => {});
    };
    refresh();
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') refresh();
    });
    return () => sub.remove();
  }, []);

  async function onSave() {
    if (!backendUrl.trim() || !bootstrapToken.trim()) {
      showAlert('Missing fields', 'Both backend URL and bootstrap token are required.');
      return;
    }
    setBusy(true);
    try {
      await saveConfig({ backendUrl, bootstrapToken });
      showAlert('Saved', 'Settings stored securely on device.');
    } catch (err) {
      showAlert('Save failed', err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setBusy(false);
    }
  }

  async function onTest() {
    setBusy(true);
    try {
      const cfg = { backendUrl: backendUrl.trim().replace(/\/+$/, ''), bootstrapToken };
      const ok = await healthCheck(cfg);
      showAlert(
        ok ? 'Connected' : 'Reachable but unhealthy',
        ok
          ? 'Backend health check passed.'
          : 'Backend responded but /health returned non-2xx.',
      );
    } catch (err) {
      showAlert(
        'Connection failed',
        err instanceof Error ? err.message : 'Could not reach the backend.',
      );
    } finally {
      setBusy(false);
    }
  }

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
      // Open the required mode chooser before committing any state.
      // onModeChosen / onModeChooserCancel handle the rest.
      setModeModalIsFirstEnable(true);
      setModeModalVisible(true);
    } else {
      await unregisterAutoBackup();
      const next = await saveAutoBackupState({ enabled: false });
      setAutoBackupState(next);
    }
  }

  // Called when the user confirms a mode in the chooser (first-enable path).
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

  // Dispatch to the correct handler based on whether this is a first-enable
  // or a post-enable mode switch.
  function onModeConfirm(result: AutoBackupModeModalConfirmResult) {
    if (modeModalIsFirstEnable) {
      onModeChosenFirstEnable(result);
    } else {
      onModeSwitched(result);
    }
  }

  // Called when the user taps the mode row while already enabled.
  function onTapModeRow() {
    setModeModalIsFirstEnable(false);
    setModeModalVisible(true);
  }

  // Called when the user confirms a mode switch from the chooser (post-enable).
  async function onModeSwitched(result: {
    mode: BackupMode;
    customStartDate: number | null;
    prefix: string; // includePrefix is false on this path; result.prefix is the echoed initialPrefix and is intentionally ignored.
  }) {
    setModeModalVisible(false);
    const currentMode = autoBackupState.backupMode;

    // Same-mode no-op.
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

    // Determine confirmation copy per the mode-switch matrix.
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
      // fromDate
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

  // Try to re-prompt for permission; if the OS won't show the dialog again
  // (Android "Don't ask again" / iOS post-denial), open system Settings.
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

  async function onToggleAutoPaused(value: boolean) {
    let next: AutoBackupState;
    if (value) {
      // Pause: record when the pause started. Defensive: don't overwrite an
      // existing pauseStartedAt if somehow called twice.
      next = await saveAutoBackupState((current) => ({
        paused: true,
        pauseStartedAt: current.pauseStartedAt ?? Date.now(),
      }));
    } else {
      // Unpause with pause-skip: if the cursor has caught up past the pause
      // start, advance lastCreatedAt to now so media taken during the pause
      // is excluded. If mid-sweep, leave the cursor alone and let it finish.
      next = await saveAutoBackupState((current) => {
        const advance =
          current.pauseStartedAt !== null &&
          current.lastCreatedAt !== null &&
          current.lastCreatedAt >= current.pauseStartedAt;
        return {
          paused: false,
          pauseStartedAt: null,
          lastCreatedAt: advance ? Date.now() : current.lastCreatedAt,
        };
      });
    }
    setAutoBackupState(next);
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

  function onClear() {
    showAlert(
      'Clear settings?',
      'This removes the backend URL and bootstrap token from this device.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Clear',
          style: 'destructive',
          onPress: async () => {
            await clearConfig();
            setBackendUrl('');
            setBootstrapToken('');
          },
        },
      ],
    );
  }

  function onScanQr() {
    setScannerVisible(true);
  }

  async function applyQrConfig(raw: string) {
    setScannerVisible(false);
    const result = parseQrPayload(raw);
    if (!result.ok) {
      const messages: Record<typeof result.reason, string> = {
        'invalid-json': 'The scanned code did not contain valid JSON. Make sure you scanned the QR code printed by npm run qr.',
        'missing-fields': 'The scanned QR code is missing the apiUrl or bootstrapToken field.',
        'bad-url': 'The API URL in the QR code is not allowed. Must be https:// (production) or http:// to a local-network address (dev).',
      };
      showAlert('Invalid QR code', messages[result.reason]);
      return;
    }
    const doSave = async () => {
      setBusy(true);
      try {
        await saveConfig(result.config);
        setBackendUrl(result.config.backendUrl);
        setBootstrapToken(result.config.bootstrapToken);
        showAlert('Saved', 'Settings stored securely on device.');
      } catch (err) {
        showAlert('Save failed', err instanceof Error ? err.message : 'Unknown error');
      } finally {
        setBusy(false);
      }
    };
    const hasExisting = backendUrl.trim() || bootstrapToken.trim();
    if (hasExisting) {
      showAlert(
        'Replace existing config?',
        'This will overwrite the current API URL and bootstrap token.',
        [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Replace', style: 'destructive', onPress: doSave },
        ],
      );
    } else {
      await doSave();
    }
  }

  async function refreshProviders() {
    const list = await getProviders();
    setProviders(list);
    const aid = await getActiveProviderId();
    setActiveId(aid ?? list[0]?.id ?? null);
  }

  async function onSelectProvider(id: string) {
    if (id === activeId) return;
    setActiveId(id);
    await setActiveProvider(id);
  }

  function openAdd() {
    setDraft(EMPTY_DRAFT);
    setEditor({ mode: 'add' });
  }

  function openEdit(p: SavedProvider) {
    setDraft({
      name: p.name,
      baseUrl: p.baseUrl,
      apiKey: p.apiKey ?? '',
      model: p.model,
    });
    setEditor({ mode: 'edit', id: p.id });
  }

  function closeEditor() {
    setEditor(null);
    setDraft(EMPTY_DRAFT);
  }

  async function onSaveProvider() {
    const name = draft.name.trim();
    const baseUrl = draft.baseUrl.trim();
    const model = draft.model.trim();
    const apiKey = draft.apiKey.trim() || null;

    if (!name || !baseUrl) {
      showAlert('Missing fields', 'Provider name and base URL are required.');
      return;
    }

    setBusy(true);
    try {
      if (editor?.mode === 'add') {
        await addProvider({ name, baseUrl, model, apiKey });
      } else if (editor?.mode === 'edit') {
        await updateProvider(editor.id, { name, baseUrl, model, apiKey });
      }
      await refreshProviders();
      closeEditor();
    } catch (err) {
      showAlert('Save failed', err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setBusy(false);
    }
  }

  function onDeleteProvider(p: SavedProvider) {
    showAlert(
      `Delete "${p.name}"?`,
      'This removes the provider. The active provider will switch to the next one in the list.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            await removeProvider(p.id);
            await refreshProviders();
          },
        },
      ],
    );
  }

  function onClearChat() {
    showAlert(
      'Clear chat history?',
      'This wipes the current Assistant conversation. Providers and settings are kept.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Clear',
          style: 'destructive',
          onPress: async () => {
            await bumpAssistantSessionResetVersion();
          },
        },
      ],
    );
  }

  const activeProvider = providers.find((p) => p.id === activeId) ?? null;
  const isLocalActive =
    activeProvider != null &&
    /^https?:\/\/(localhost|127\.|192\.168\.|10\.|172\.)/i.test(activeProvider.baseUrl);

  if (loading) {
    return (
      <ThemedView style={[styles.container, styles.center]}>
        <ActivityIndicator />
      </ThemedView>
    );
  }

  return (
    <KeyboardAvoidingView
      style={{ flex: 1 }}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
        <ThemedView style={styles.container}>
          <ThemedText style={[styles.hint, { color: colors.muted }]}>
            Paste the API URL and bootstrap token from your backend deploy, or scan the QR code
            printed by <ThemedText style={{ color: colors.text, fontWeight: '600' }}>npm run qr</ThemedText>.
          </ThemedText>

          <Pressable
            accessibilityRole="button"
            disabled={busy}
            onPress={onScanQr}
            style={({ pressed }) => [
              styles.scanButton,
              {
                backgroundColor: colors.accentSoft,
                borderColor: colors.tint,
                opacity: pressed || busy ? 0.7 : 1,
              },
            ]}>
            <Ionicons name="qr-code-outline" size={20} color={colors.tint} />
            <ThemedText style={[styles.scanButtonText, { color: colors.tint }]}>
              Scan QR
            </ThemedText>
          </Pressable>

          <View style={[styles.card, { backgroundColor: colors.surface }]}>
            <View style={styles.field}>
              <ThemedText style={styles.fieldLabel}>API URL</ThemedText>
              <TextInput
                value={backendUrl}
                onChangeText={setBackendUrl}
                placeholder="https://xxxxx.execute-api.region.amazonaws.com"
                placeholderTextColor={colors.muted}
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="url"
                style={[
                  styles.input,
                  { color: colors.text, backgroundColor: colors.surfaceMuted },
                ]}
              />
            </View>

            <View style={styles.field}>
              <ThemedText style={styles.fieldLabel}>Bootstrap token</ThemedText>
              <SecretInput
                value={bootstrapToken}
                onChangeText={setBootstrapToken}
                placeholder="64-character hex string"
                placeholderTextColor={colors.muted}
                inputStyle={[
                  styles.input,
                  { color: colors.text, backgroundColor: colors.surfaceMuted },
                ]}
                iconColor={colors.muted}
              />
            </View>
          </View>

          <View style={styles.buttonRow}>
            <Pressable
              accessibilityRole="button"
              disabled={busy}
              onPress={onSave}
              style={({ pressed }) => [
                styles.button,
                { backgroundColor: colors.tint, opacity: pressed || busy ? 0.7 : 1 },
              ]}>
              <ThemedText style={[styles.buttonText, { color: colors.onAccent }]}>
                Save
              </ThemedText>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              disabled={busy || !backendUrl}
              onPress={onTest}
              style={({ pressed }) => [
                styles.button,
                { backgroundColor: colors.surfaceMuted, opacity: pressed || busy ? 0.7 : 1 },
              ]}>
              <ThemedText style={[styles.buttonText, { color: colors.tint }]}>Test</ThemedText>
            </Pressable>
          </View>

          <ThemedText style={[styles.sectionHeader, { color: colors.muted }]}>
            Auto-backup
          </ThemedText>

          {!hasConfig && (
            <ThemedText style={[styles.hint, { color: colors.muted }]}>
              Configure your backend in the section above before enabling auto-backup.
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
                      Auto-backup is paused until you grant access. Tap to fix.
                    </ThemedText>
                  </View>
                  <Ionicons name="chevron-forward" size={18} color={colors.danger} />
                </Pressable>
              )}

            {autoBackupState.enabled && (
              <View
                style={[
                  styles.toggleRow,
                  { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
                ]}>
                <View style={{ flex: 1 }}>
                  <ThemedText style={[Type.body, { color: colors.text }]}>Paused</ThemedText>
                  <ThemedText style={[Type.meta, { color: colors.muted }]}>
                    Skip ticks. Media created while paused won&apos;t be uploaded after resuming.
                  </ThemedText>
                </View>
                <Switch
                  value={autoBackupState.paused}
                  onValueChange={onToggleAutoPaused}
                  trackColor={{ false: colors.border, true: colors.tint }}
                  thumbColor={colors.onAccent}
                />
              </View>
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
          </View>

          <ThemedText style={[styles.sectionHeader, { color: colors.muted }]}>
            Assistant
          </ThemedText>

          <ThemedText style={[styles.hint, { color: colors.muted }]}>
            The Assistant tab talks to any OpenAI-compatible chat endpoint. Pick which provider
            is active; tap the pencil to edit, the trash to delete. Filenames and folder
            metadata you ask about{' '}
            {isLocalActive
              ? 'stay on your device (local endpoint).'
              : `are sent to ${activeProvider?.name ?? 'the selected provider'}.`}{' '}
            Image bytes are not sent.
          </ThemedText>

          <View style={[styles.card, { backgroundColor: colors.surface, padding: 0 }]}>
            {providers.length === 0 ? (
              <View style={styles.emptyRow}>
                <ThemedText style={[Type.body, { color: colors.muted }]}>
                  No providers yet.
                </ThemedText>
              </View>
            ) : (
              providers.map((p, i) => {
                const selected = p.id === activeId;
                return (
                  <Pressable
                    key={p.id}
                    accessibilityRole="button"
                    accessibilityState={{ selected }}
                    onPress={() => onSelectProvider(p.id)}
                    style={({ pressed }) => [
                      styles.providerRow,
                      {
                        backgroundColor: pressed ? colors.surfaceMuted : 'transparent',
                        borderTopColor: colors.border,
                        borderTopWidth: i === 0 ? 0 : StyleSheet.hairlineWidth,
                      },
                    ]}>
                    <View style={styles.providerRowMain}>
                      <Ionicons
                        name={selected ? 'radio-button-on' : 'radio-button-off'}
                        size={20}
                        color={selected ? colors.tint : colors.muted}
                      />
                      <View style={styles.providerRowText}>
                        <ThemedText style={[Type.body, { color: colors.text, fontWeight: '600' }]}>
                          {p.name}
                        </ThemedText>
                        <ThemedText
                          numberOfLines={1}
                          style={[Type.meta, { color: colors.muted }]}>
                          {p.model ? `${p.model} · ` : ''}{p.baseUrl}
                        </ThemedText>
                      </View>
                    </View>
                    <View style={styles.providerRowActions}>
                      <Pressable
                        accessibilityRole="button"
                        accessibilityLabel={`Edit ${p.name}`}
                        onPress={() => openEdit(p)}
                        hitSlop={8}
                        style={({ pressed }) => ({ opacity: pressed ? 0.5 : 1, padding: 6 })}>
                        <Ionicons name="pencil-outline" size={18} color={colors.muted} />
                      </Pressable>
                      <Pressable
                        accessibilityRole="button"
                        accessibilityLabel={`Delete ${p.name}`}
                        onPress={() => onDeleteProvider(p)}
                        hitSlop={8}
                        style={({ pressed }) => ({ opacity: pressed ? 0.5 : 1, padding: 6 })}>
                        <Ionicons name="trash-outline" size={18} color={colors.danger} />
                      </Pressable>
                    </View>
                  </Pressable>
                );
              })
            )}
          </View>

          <Pressable
            accessibilityRole="button"
            onPress={openAdd}
            style={({ pressed }) => [
              styles.addButton,
              {
                backgroundColor: colors.accentSoft,
                borderColor: colors.tint,
                opacity: pressed ? 0.7 : 1,
              },
            ]}>
            <Ionicons name="add" size={18} color={colors.tint} />
            <ThemedText style={[styles.scanButtonText, { color: colors.tint }]}>
              Add provider
            </ThemedText>
          </Pressable>

          {providers.length > 0 ? (
            <Pressable
              accessibilityRole="button"
              onPress={onClearChat}
              style={({ pressed }) => [styles.subtleButton, { opacity: pressed ? 0.7 : 1 }]}>
              <ThemedText style={{ color: colors.muted, fontWeight: '500' }}>
                Clear chat history
              </ThemedText>
            </Pressable>
          ) : null}

          <View style={[styles.card, { backgroundColor: colors.surface }]}>
            <Pressable
              accessibilityRole="button"
              onPress={() => router.push('/about')}
              style={({ pressed }) => [styles.navRow, { opacity: pressed ? 0.7 : 1 }]}>
              <ThemedText style={[Type.body, { color: colors.text }]}>About</ThemedText>
              <Ionicons name="chevron-forward" size={18} color={colors.muted} />
            </Pressable>
          </View>

          <Pressable
            accessibilityRole="button"
            onPress={onClear}
            style={styles.clearButton}>
            <ThemedText style={{ color: colors.danger, fontWeight: '500' }}>
              Clear stored settings
            </ThemedText>
          </Pressable>
        </ThemedView>
      </ScrollView>

      <QrScannerModal
        visible={scannerVisible}
        onClose={() => setScannerVisible(false)}
        onScanned={applyQrConfig}
      />

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

      <ModalCard
        visible={editor !== null}
        onRequestClose={closeEditor}
        title={editor?.mode === 'edit' ? 'Edit provider' : 'Add provider'}>
        <View style={styles.field}>
          <ThemedText style={styles.fieldLabel}>Name</ThemedText>
          <TextInput
            value={draft.name}
            onChangeText={(v) => setDraft((d) => ({ ...d, name: v }))}
            placeholder="My provider"
            placeholderTextColor={colors.muted}
            autoCapitalize="none"
            autoCorrect={false}
            style={[styles.input, { color: colors.text, backgroundColor: colors.surfaceMuted }]}
          />
        </View>
        <View style={styles.field}>
          <ThemedText style={styles.fieldLabel}>Base URL</ThemedText>
          <TextInput
            value={draft.baseUrl}
            onChangeText={(v) => setDraft((d) => ({ ...d, baseUrl: v }))}
            placeholder="https://…/v1"
            placeholderTextColor={colors.muted}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            style={[styles.input, { color: colors.text, backgroundColor: colors.surfaceMuted }]}
          />
        </View>
        <View style={styles.field}>
          <ThemedText style={styles.fieldLabel}>API key (optional)</ThemedText>
          <SecretInput
            value={draft.apiKey}
            onChangeText={(v) => setDraft((d) => ({ ...d, apiKey: v }))}
            placeholder="Leave blank for local endpoints"
            placeholderTextColor={colors.muted}
            inputStyle={[styles.input, { color: colors.text, backgroundColor: colors.surfaceMuted }]}
            iconColor={colors.muted}
          />
        </View>
        <View style={styles.field}>
          <ThemedText style={styles.fieldLabel}>Model</ThemedText>
          <TextInput
            value={draft.model}
            onChangeText={(v) => setDraft((d) => ({ ...d, model: v }))}
            placeholder="e.g. meta-llama/llama-3.3-70b-instruct:free"
            placeholderTextColor={colors.muted}
            autoCapitalize="none"
            autoCorrect={false}
            style={[styles.input, { color: colors.text, backgroundColor: colors.surfaceMuted }]}
          />
          <ThemedText style={[Type.meta, { color: colors.muted, marginTop: 4 }]}>
            Use a tool-capable model — small local models often can&apos;t emit tool calls reliably.
          </ThemedText>
        </View>

        <View style={styles.buttonRow}>
          <Pressable
            accessibilityRole="button"
            onPress={closeEditor}
            style={({ pressed }) => [
              styles.button,
              { backgroundColor: colors.surfaceMuted, opacity: pressed ? 0.7 : 1 },
            ]}>
            <ThemedText style={[styles.buttonText, { color: colors.text }]}>Cancel</ThemedText>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            disabled={busy}
            onPress={onSaveProvider}
            style={({ pressed }) => [
              styles.button,
              { backgroundColor: colors.tint, opacity: pressed || busy ? 0.7 : 1 },
            ]}>
            <ThemedText style={[styles.buttonText, { color: colors.onAccent }]}>Save</ThemedText>
          </Pressable>
        </View>
      </ModalCard>
    </KeyboardAvoidingView>
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

function SecretInput({
  value,
  onChangeText,
  placeholder,
  placeholderTextColor,
  inputStyle,
  iconColor,
}: {
  value: string;
  onChangeText: (v: string) => void;
  placeholder: string;
  placeholderTextColor: string;
  inputStyle: TextInputProps['style'];
  iconColor: string;
}) {
  const [visible, setVisible] = useState(false);
  return (
    <View style={styles.secretWrapper}>
      <TextInput
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={placeholderTextColor}
        autoCapitalize="none"
        autoCorrect={false}
        secureTextEntry={!visible}
        style={[inputStyle, styles.secretInput]}
      />
      <Pressable
        onPress={() => setVisible((v) => !v)}
        hitSlop={8}
        accessibilityRole="button"
        accessibilityLabel={visible ? 'Hide value' : 'Show value'}
        style={({ pressed }) => [styles.secretToggle, { opacity: pressed ? 0.6 : 1 }]}>
        <Ionicons
          name={visible ? 'eye-off-outline' : 'eye-outline'}
          size={20}
          color={iconColor}
        />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: Spacing.lg, gap: Spacing.md },
  center: { alignItems: 'center', justifyContent: 'center' },
  scroll: { flexGrow: 1 },
  hint: { fontSize: 14, marginBottom: Spacing.xs, marginTop: Spacing.xs },
  card: {
    padding: Spacing.lg,
    borderRadius: Radius.lg,
    gap: Spacing.lg,
  },
  field: { gap: Spacing.xs },
  fieldLabel: { fontSize: 13, fontWeight: '600' },
  input: {
    borderRadius: Radius.md,
    paddingHorizontal: Spacing.md,
    paddingVertical: 12,
    fontSize: 16,
  },
  secretWrapper: { position: 'relative' },
  secretInput: { paddingRight: 44 },
  secretToggle: {
    position: 'absolute',
    right: 4,
    top: 0,
    bottom: 0,
    width: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  scanButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.sm,
    paddingVertical: 14,
    borderRadius: Radius.md,
    borderWidth: 1,
  },
  scanButtonText: { fontWeight: '600', fontSize: 15 },
  buttonRow: { flexDirection: 'row', gap: Spacing.md, marginTop: Spacing.xs },
  button: {
    flex: 1,
    paddingVertical: 14,
    borderRadius: Radius.md,
    alignItems: 'center',
  },
  buttonText: { fontWeight: '600', fontSize: 15 },
  clearButton: { marginTop: Spacing.xl, alignItems: 'center', paddingVertical: 8 },
  sectionHeader: {
    fontSize: 11,
    fontWeight: '600',
    letterSpacing: 0.6,
    textTransform: 'uppercase',
    marginTop: Spacing.lg,
  },
  providerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.md,
    gap: Spacing.sm,
  },
  providerRowMain: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
  },
  providerRowText: { flex: 1 },
  providerRowActions: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  addButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.sm,
    paddingVertical: 12,
    borderRadius: Radius.md,
    borderWidth: 1,
    borderStyle: 'dashed',
  },
  emptyRow: {
    padding: Spacing.lg,
    alignItems: 'center',
  },
  subtleButton: {
    alignItems: 'center',
    paddingVertical: 10,
  },
  navRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
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
