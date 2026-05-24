import DateTimePicker, {
  DateTimePickerAndroid,
} from '@react-native-community/datetimepicker';
import { useState } from 'react';
import {
  Platform,
  Pressable,
  StyleSheet,
  View,
} from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { ModalCard } from '@/components/ui/modal-card';
import { Colors, Radius, Spacing, Type } from '@/constants/theme';
import { useColorScheme } from '@/hooks/use-color-scheme';
import { type BackupMode } from '@/lib/autoBackupState';

export type AutoBackupModeModalProps = {
  visible: boolean;
  /** Pre-selected mode when re-opening for a switch. Undefined on first-enable. */
  initialMode?: BackupMode;
  /** Pre-selected date for 'fromDate' mode re-open. */
  initialCustomDate?: number | null;
  onConfirm: (result: { mode: BackupMode; customStartDate: number | null }) => void;
  /** Called only when user taps the explicit Cancel button. */
  onCancel: () => void;
};

function midnightLocal(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0).getTime();
}

function todayMidnight(): number {
  return midnightLocal(new Date());
}

function tenYearsAgo(): Date {
  const d = new Date();
  d.setFullYear(d.getFullYear() - 10);
  return d;
}

export function AutoBackupModeModal({
  visible,
  initialMode,
  initialCustomDate,
  onConfirm,
  onCancel,
}: AutoBackupModeModalProps) {
  const colorScheme = useColorScheme() ?? 'light';
  const colors = Colors[colorScheme];

  const [selectedMode, setSelectedMode] = useState<BackupMode | undefined>(initialMode);
  // Default date for 'fromDate' is today.
  const [fromDate, setFromDate] = useState<Date>(
    initialCustomDate != null ? new Date(initialCustomDate) : new Date(),
  );

  // Sync internal state when the modal is opened (visibility flip).
  const [lastVisible, setLastVisible] = useState(visible);
  if (visible !== lastVisible) {
    setLastVisible(visible);
    if (visible) {
      setSelectedMode(initialMode);
      setFromDate(initialCustomDate != null ? new Date(initialCustomDate) : new Date());
    }
  }

  const today = new Date();
  const minDate = tenYearsAgo();

  function openAndroidDatePicker() {
    DateTimePickerAndroid.open({
      value: fromDate,
      mode: 'date',
      maximumDate: today,
      minimumDate: minDate,
      onChange: (_event, selected) => {
        if (selected) setFromDate(selected);
      },
    });
  }

  function handleConfirm() {
    if (!selectedMode) return;
    if (selectedMode === 'fromDate') {
      onConfirm({ mode: 'fromDate', customStartDate: midnightLocal(fromDate) });
    } else if (selectedMode === 'newOnly') {
      onConfirm({ mode: 'newOnly', customStartDate: null });
    } else {
      onConfirm({ mode: 'all', customStartDate: null });
    }
  }

  const confirmEnabled = selectedMode !== undefined;

  const fromDateLabel = fromDate.toLocaleDateString(undefined, {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });

  return (
    <ModalCard
      visible={visible}
      // Android back button must NOT cancel — user must tap explicit Cancel.
      onRequestClose={() => {}}
      dismissOnBackdrop={false}
      title="Choose backup start point">
      {/* Option: Everything */}
      <Pressable
        accessibilityRole="radio"
        accessibilityState={{ checked: selectedMode === 'all' }}
        onPress={() => setSelectedMode('all')}
        style={({ pressed }) => [
          styles.option,
          {
            backgroundColor:
              selectedMode === 'all' ? colors.accentSoft : colors.surface,
            borderColor: selectedMode === 'all' ? colors.tint : colors.border,
            opacity: pressed ? 0.7 : 1,
          },
        ]}>
        <View style={styles.optionRadio}>
          <View
            style={[
              styles.radioOuter,
              { borderColor: selectedMode === 'all' ? colors.tint : colors.border },
            ]}>
            {selectedMode === 'all' && (
              <View style={[styles.radioInner, { backgroundColor: colors.tint }]} />
            )}
          </View>
        </View>
        <View style={styles.optionText}>
          <ThemedText style={[Type.body, { color: colors.text, fontWeight: '600' }]}>
            Everything
          </ThemedText>
          <ThemedText style={[Type.meta, { color: colors.muted }]}>
            Back up your entire photo library
          </ThemedText>
        </View>
      </Pressable>

      {/* Option: New media only */}
      <Pressable
        accessibilityRole="radio"
        accessibilityState={{ checked: selectedMode === 'newOnly' }}
        onPress={() => setSelectedMode('newOnly')}
        style={({ pressed }) => [
          styles.option,
          {
            backgroundColor:
              selectedMode === 'newOnly' ? colors.accentSoft : colors.surface,
            borderColor: selectedMode === 'newOnly' ? colors.tint : colors.border,
            opacity: pressed ? 0.7 : 1,
          },
        ]}>
        <View style={styles.optionRadio}>
          <View
            style={[
              styles.radioOuter,
              { borderColor: selectedMode === 'newOnly' ? colors.tint : colors.border },
            ]}>
            {selectedMode === 'newOnly' && (
              <View style={[styles.radioInner, { backgroundColor: colors.tint }]} />
            )}
          </View>
        </View>
        <View style={styles.optionText}>
          <ThemedText style={[Type.body, { color: colors.text, fontWeight: '600' }]}>
            New media only
          </ThemedText>
          <ThemedText style={[Type.meta, { color: colors.muted }]}>
            Skip existing photos — only back up from now on
          </ThemedText>
        </View>
      </Pressable>

      {/* Option: From a specific date */}
      <Pressable
        accessibilityRole="radio"
        accessibilityState={{ checked: selectedMode === 'fromDate' }}
        onPress={() => setSelectedMode('fromDate')}
        style={({ pressed }) => [
          styles.option,
          {
            backgroundColor:
              selectedMode === 'fromDate' ? colors.accentSoft : colors.surface,
            borderColor: selectedMode === 'fromDate' ? colors.tint : colors.border,
            opacity: pressed ? 0.7 : 1,
          },
        ]}>
        <View style={styles.optionRadio}>
          <View
            style={[
              styles.radioOuter,
              { borderColor: selectedMode === 'fromDate' ? colors.tint : colors.border },
            ]}>
            {selectedMode === 'fromDate' && (
              <View style={[styles.radioInner, { backgroundColor: colors.tint }]} />
            )}
          </View>
        </View>
        <View style={styles.optionText}>
          <ThemedText style={[Type.body, { color: colors.text, fontWeight: '600' }]}>
            From a specific date
          </ThemedText>
          <ThemedText style={[Type.meta, { color: colors.muted }]}>
            Back up media created on or after a chosen date
          </ThemedText>
        </View>
      </Pressable>

      {/* Inline date picker — only visible when 'fromDate' is selected */}
      {selectedMode === 'fromDate' && (
        <View
          style={[
            styles.datePicker,
            { backgroundColor: colors.surfaceMuted, borderColor: colors.border },
          ]}>
          <ThemedText style={[Type.label, { color: colors.text, flex: 1 }]}>
            Start date
          </ThemedText>
          {Platform.OS === 'android' ? (
            <Pressable
              onPress={openAndroidDatePicker}
              style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })}>
              <ThemedText style={[Type.label, { color: colors.tint }]}>
                {fromDateLabel}
              </ThemedText>
            </Pressable>
          ) : (
            <DateTimePicker
              mode="date"
              display="compact"
              value={fromDate}
              maximumDate={today}
              minimumDate={minDate}
              onChange={(_event, selected) => {
                if (selected) setFromDate(selected);
              }}
              themeVariant={colorScheme}
            />
          )}
        </View>
      )}

      {/* Actions */}
      <View style={styles.actions}>
        <Pressable
          onPress={onCancel}
          style={({ pressed }) => [styles.actionBtn, { opacity: pressed ? 0.7 : 1 }]}>
          <ThemedText style={[Type.body, { color: colors.muted }]}>Cancel</ThemedText>
        </Pressable>
        <Pressable
          onPress={handleConfirm}
          disabled={!confirmEnabled}
          style={({ pressed }) => [
            styles.actionBtn,
            styles.confirmBtn,
            { backgroundColor: colors.tint, opacity: pressed || !confirmEnabled ? 0.5 : 1 },
          ]}>
          <ThemedText style={[Type.bodyStrong, { color: colors.onAccent }]}>Confirm</ThemedText>
        </Pressable>
      </View>
    </ModalCard>
  );
}

const styles = StyleSheet.create({
  option: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: Spacing.md,
    borderRadius: Radius.md,
    borderWidth: 1,
    padding: Spacing.md,
  },
  optionRadio: {
    paddingTop: 2,
  },
  radioOuter: {
    width: 20,
    height: 20,
    borderRadius: 10,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  radioInner: {
    width: 10,
    height: 10,
    borderRadius: 5,
  },
  optionText: {
    flex: 1,
    gap: Spacing.xs,
  },
  datePicker: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: Spacing.md,
    borderRadius: Radius.md,
    borderWidth: 1,
    gap: Spacing.sm,
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
  confirmBtn: {},
});
