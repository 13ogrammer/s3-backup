import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  type TextInputProps,
  View,
} from 'react-native';

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

  useEffect(() => {
    Promise.all([loadConfig(), getProviders(), getActiveProviderId()]).then(([cfg, list, aid]) => {
      if (cfg) {
        setBackendUrl(cfg.backendUrl);
        setBootstrapToken(cfg.bootstrapToken);
      }
      setProviders(list);
      setActiveId(aid ?? list[0]?.id ?? null);
      setLoading(false);
    });
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
});
