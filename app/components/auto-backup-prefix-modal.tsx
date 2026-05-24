import { useState } from 'react';
import {
  Pressable,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { ModalCard } from '@/components/ui/modal-card';
import { Colors, Radius, Spacing, Type } from '@/constants/theme';
import { useColorScheme } from '@/hooks/use-color-scheme';
import { validatePrefix } from '@/lib/prefixValidation';

export type AutoBackupPrefixModalProps = {
  visible: boolean;
  initialValue: string;
  onSave: (sanitized: string) => void;
  onCancel: () => void;
};

function todayDateString(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function AutoBackupPrefixModal({
  visible,
  initialValue,
  onSave,
  onCancel,
}: AutoBackupPrefixModalProps) {
  const colorScheme = useColorScheme() ?? 'light';
  const colors = Colors[colorScheme];

  const [draft, setDraft] = useState(initialValue);

  // Keep draft in sync when the modal is reopened with a different value.
  const [lastVisible, setLastVisible] = useState(visible);
  if (visible !== lastVisible) {
    setLastVisible(visible);
    if (visible) setDraft(initialValue);
  }

  const validation = validatePrefix(draft);
  const hasError = !validation.ok;
  const sanitized = validation.ok ? validation.value : '';

  const dateStr = todayDateString();
  const preview = sanitized
    ? `${sanitized}${dateStr}/IMG_0001.jpg`
    : `${dateStr}/IMG_0001.jpg`;

  function handleSave() {
    if (!validation.ok) return;
    onSave(validation.value);
  }

  return (
    <ModalCard visible={visible} onRequestClose={onCancel} title="Upload folder prefix">
      <View style={styles.field}>
        <ThemedText style={[Type.label, { color: colors.muted }]}>
          Folder prefix
        </ThemedText>
        <TextInput
          value={draft}
          onChangeText={setDraft}
          placeholder="auto/"
          placeholderTextColor={colors.muted}
          autoCapitalize="none"
          autoCorrect={false}
          style={[
            styles.input,
            {
              color: colors.text,
              backgroundColor: colors.surfaceMuted,
              borderColor: hasError ? colors.danger : colors.border,
            },
          ]}
        />
      </View>

      {hasError && (
        <ThemedText style={[Type.meta, { color: colors.danger }]}>
          {validation.error}
        </ThemedText>
      )}

      {!hasError && (
        <View
          style={[
            styles.preview,
            { backgroundColor: colors.surfaceMuted, borderColor: colors.border },
          ]}>
          <ThemedText style={[Type.meta, { color: colors.muted }]}>Preview</ThemedText>
          <ThemedText
            style={[Type.meta, { color: colors.text, fontWeight: '600' }]}
            numberOfLines={2}>
            {preview}
          </ThemedText>
        </View>
      )}

      <ThemedText style={[Type.meta, { color: colors.muted }]}>
        Changes apply to new uploads only. Existing files stay at their current location.
      </ThemedText>

      <View style={styles.actions}>
        <Pressable
          onPress={onCancel}
          style={({ pressed }) => [styles.actionBtn, { opacity: pressed ? 0.7 : 1 }]}>
          <ThemedText style={[Type.body, { color: colors.muted }]}>Cancel</ThemedText>
        </Pressable>
        <Pressable
          onPress={handleSave}
          disabled={hasError}
          style={({ pressed }) => [
            styles.actionBtn,
            styles.saveBtn,
            { backgroundColor: colors.tint, opacity: pressed || hasError ? 0.5 : 1 },
          ]}>
          <ThemedText style={[Type.bodyStrong, { color: colors.onAccent }]}>Save</ThemedText>
        </Pressable>
      </View>
    </ModalCard>
  );
}

const styles = StyleSheet.create({
  field: {
    gap: Spacing.xs,
  },
  input: {
    borderRadius: Radius.md,
    borderWidth: 1,
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm,
    fontSize: 16,
  },
  preview: {
    padding: Spacing.md,
    borderRadius: Radius.md,
    borderWidth: 1,
    gap: Spacing.xs,
  },
  actions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: Spacing.sm,
    marginTop: Spacing.xs,
  },
  actionBtn: {
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm,
    borderRadius: Radius.md,
  },
  saveBtn: {},
});
