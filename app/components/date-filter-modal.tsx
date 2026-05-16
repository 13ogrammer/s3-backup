import DateTimePicker, {
  DateTimePickerAndroid,
} from '@react-native-community/datetimepicker';
import { useState } from 'react';
import {
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  View,
} from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Colors, Radius, Shadow, Spacing, Type } from '@/constants/theme';
import { useColorScheme } from '@/hooks/use-color-scheme';

export type DateFilter = {
  start: Date | null;
  end: Date | null;
};

export type DateFilterModalProps = {
  visible: boolean;
  value: DateFilter;
  onApply: (next: DateFilter) => void;
  onClear: () => void;
  onClose: () => void;
};

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
}

function endOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999);
}

export function DateFilterModal({
  visible,
  value,
  onApply,
  onClear,
  onClose,
}: DateFilterModalProps) {
  const colorScheme = useColorScheme() ?? 'light';
  const colors = Colors[colorScheme];

  const [draft, setDraft] = useState<DateFilter>(value);

  // Keep draft in sync when the modal is reopened with a different external value.
  // We use key-on-visible in the parent, but also guard here.
  const [lastVisible, setLastVisible] = useState(visible);
  if (visible !== lastVisible) {
    setLastVisible(visible);
    if (visible) setDraft(value);
  }

  const startInvalid =
    draft.start !== null &&
    draft.end !== null &&
    draft.start > draft.end;

  const hasValue = draft.start !== null || draft.end !== null;

  function openAndroidPicker(field: 'start' | 'end') {
    const current =
      field === 'start'
        ? draft.start ?? new Date()
        : draft.end ?? new Date();

    DateTimePickerAndroid.open({
      value: current,
      mode: 'date',
      onChange: (_event, selected) => {
        if (!selected) return;
        setDraft((prev) => ({ ...prev, [field]: selected }));
      },
    });
  }

  function handleApply() {
    if (startInvalid) return;
    const next: DateFilter = {
      start: draft.start ? startOfDay(draft.start) : null,
      end: draft.end ? endOfDay(draft.end) : null,
    };
    onApply(next);
  }

  const rowValueStyle = [styles.rowValue, { color: colors.tint }];

  function renderPickerRow(label: string, field: 'start' | 'end') {
    const date = field === 'start' ? draft.start : draft.end;
    const displayLabel = date
      ? date.toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' })
      : 'Any';

    if (Platform.OS === 'android') {
      return (
        <Pressable
          onPress={() => openAndroidPicker(field)}
          style={[styles.row, { borderColor: colors.border }]}>
          <ThemedText style={styles.rowLabel}>{label}</ThemedText>
          <ThemedText style={rowValueStyle}>{displayLabel}</ThemedText>
        </Pressable>
      );
    }

    // iOS: inline picker rendered directly in the modal card.
    return (
      <View style={[styles.iosPickerRow, { borderColor: colors.border }]}>
        <ThemedText style={styles.rowLabel}>{label}</ThemedText>
        <DateTimePicker
          mode="date"
          display="compact"
          value={date ?? new Date()}
          maximumDate={new Date()}
          onChange={(_event, selected) => {
            if (!selected) return;
            setDraft((prev) => ({ ...prev, [field]: selected }));
          }}
          themeVariant={colorScheme}
        />
        {date !== null && (
          <Pressable
            onPress={() => setDraft((prev) => ({ ...prev, [field]: null }))}
            style={styles.clearFieldBtn}
            hitSlop={8}>
            <ThemedText style={{ color: colors.muted, fontSize: 12 }}>Clear</ThemedText>
          </Pressable>
        )}
      </View>
    );
  }

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        {/* stop propagation so tapping the card doesn't close */}
        <Pressable onPress={() => {}}>
          <ThemedView
            style={[
              styles.card,
              { borderColor: colors.border },
              Shadow.cardElevated,
            ]}>
            <ThemedText style={styles.title}>Filter by date</ThemedText>

            {renderPickerRow('From', 'start')}
            {renderPickerRow('To', 'end')}

            {startInvalid && (
              <ThemedText style={[styles.errorText, { color: colors.danger }]}>
                Start date must be on or before end date.
              </ThemedText>
            )}

            <View style={styles.actions}>
              <Pressable onPress={onClose} style={styles.actionBtn}>
                <ThemedText style={{ color: colors.muted }}>Cancel</ThemedText>
              </Pressable>
              <Pressable
                onPress={() => {
                  setDraft({ start: null, end: null });
                  onClear();
                }}
                disabled={!hasValue}
                style={[styles.actionBtn, !hasValue && styles.disabledBtn]}>
                <ThemedText style={{ color: hasValue ? colors.danger : colors.muted }}>
                  Clear
                </ThemedText>
              </Pressable>
              <Pressable
                onPress={handleApply}
                disabled={startInvalid}
                style={[
                  styles.actionBtn,
                  styles.applyBtn,
                  { backgroundColor: colors.tint },
                  startInvalid && styles.disabledBtn,
                ]}>
                <ThemedText style={{ color: colors.onAccent, fontWeight: '600' }}>
                  Apply
                </ThemedText>
              </Pressable>
            </View>
          </ThemedView>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.45)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: Spacing.xl,
  },
  card: {
    width: '100%',
    borderRadius: Radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    padding: Spacing.lg,
    gap: Spacing.md,
  },
  title: {
    ...Type.bodyStrong,
    marginBottom: Spacing.xs,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: Spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  iosPickerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: Spacing.xs,
    borderBottomWidth: StyleSheet.hairlineWidth,
    gap: Spacing.sm,
  },
  rowLabel: {
    ...Type.label,
    flex: 1,
  },
  rowValue: {
    ...Type.label,
  },
  clearFieldBtn: {
    paddingHorizontal: Spacing.xs,
  },
  errorText: {
    fontSize: 12,
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
  applyBtn: {},
  disabledBtn: {
    opacity: 0.4,
  },
});
