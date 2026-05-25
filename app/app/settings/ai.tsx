import { Ionicons } from '@expo/vector-icons';
import { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';

import { SecretInput } from '@/components/secret-input';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { useAlert } from '@/components/ui/alert-provider';
import { ModalCard } from '@/components/ui/modal-card';
import { Colors, Radius, Spacing, Type } from '@/constants/theme';
import { useColorScheme } from '@/hooks/use-color-scheme';
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

export default function AIScreen() {
  const colorScheme = useColorScheme() ?? 'light';
  const colors = Colors[colorScheme];
  const { showAlert } = useAlert();

  const [providers, setProviders] = useState<SavedProvider[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [editor, setEditor] = useState<EditorState>(null);
  const [draft, setDraft] = useState<EditorDraft>(EMPTY_DRAFT);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([getProviders(), getActiveProviderId()]).then(([list, aid]) => {
      setProviders(list);
      setActiveId(aid ?? list[0]?.id ?? null);
      setLoading(false);
    });
  }, []);

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
            <ThemedText style={[styles.addButtonText, { color: colors.tint }]}>
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
        </ThemedView>
      </ScrollView>

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

const styles = StyleSheet.create({
  container: { flex: 1, padding: Spacing.lg, gap: Spacing.md },
  center: { alignItems: 'center', justifyContent: 'center' },
  scroll: { flexGrow: 1 },
  hint: { fontSize: 14, marginBottom: Spacing.xs, marginTop: Spacing.xs },
  card: {
    borderRadius: Radius.lg,
    overflow: 'hidden',
  },
  field: { gap: Spacing.xs },
  fieldLabel: { fontSize: 13, fontWeight: '600' },
  input: {
    borderRadius: Radius.md,
    paddingHorizontal: Spacing.md,
    paddingVertical: 12,
    fontSize: 16,
  },
  buttonRow: { flexDirection: 'row', gap: Spacing.md, marginTop: Spacing.xs },
  button: {
    flex: 1,
    paddingVertical: 14,
    borderRadius: Radius.md,
    alignItems: 'center',
  },
  buttonText: { fontWeight: '600', fontSize: 15 },
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
  addButtonText: { fontWeight: '600', fontSize: 15 },
  emptyRow: {
    padding: Spacing.lg,
    alignItems: 'center',
  },
  subtleButton: {
    alignItems: 'center',
    paddingVertical: 10,
  },
});
