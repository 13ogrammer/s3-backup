import DateTimePicker, {
  DateTimePickerAndroid,
} from '@react-native-community/datetimepicker';
import { useState } from 'react';
import {
  Platform,
  Pressable,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { ModalCard } from '@/components/ui/modal-card';
import { Colors, Radius, Spacing, Type } from '@/constants/theme';
import { useColorScheme } from '@/hooks/use-color-scheme';
import { type BackupMode } from '@/lib/autoBackupState';
import { validatePrefix } from '@/lib/prefixValidation';

export type AutoBackupModeModalConfirmResult = {
  mode: BackupMode;
  customStartDate: number | null;
  // Sanitised prefix from validatePrefix. Always present.
  // Mode-switch callers (includePrefix=false) ignore — it echoes initialPrefix.
  prefix: string;
};

export type AutoBackupModeModalProps = {
  visible: boolean;
  /** Pre-selected mode when re-opening for a switch. Undefined on first-enable. */
  initialMode?: BackupMode;
  /** Pre-selected date for 'fromDate' mode re-open. */
  initialCustomDate?: number | null;
  /**
   * When true, renders inline "Folder prefix" field below the date-picker block.
   * First-enable only. Defaults to false.
   */
  includePrefix?: boolean;
  /** Initial value for the inline prefix field. settings.tsx passes autoBackupState.prefix. */
  initialPrefix?: string;
  onConfirm: (result: AutoBackupModeModalConfirmResult) => void;
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

function todayDateString(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function AutoBackupModeModal({
  visible,
  initialMode,
  initialCustomDate,
  includePrefix = false,
  initialPrefix = '',
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
  const [prefixDraft, setPrefixDraft] = useState<string>(initialPrefix);

  // Sync internal state when the modal is opened (visibility flip).
  const [lastVisible, setLastVisible] = useState(visible);
  if (visible !== lastVisible) {
    setLastVisible(visible);
    if (visible) {
      setSelectedMode(initialMode);
      setFromDate(initialCustomDate != null ? new Date(initialCustomDate) : new Date());
      setPrefixDraft(initialPrefix);
    }
  }

  const today = new Date();
  const minDate = tenYearsAgo();

  // Derive per render — no extra state needed.
  const prefixValidation = includePrefix ? validatePrefix(prefixDraft) : null;
  const prefixOk = !includePrefix || prefixValidation!.ok;

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
    if (includePrefix && !prefixValidation!.ok) return;

    const prefixOut =
      includePrefix && prefixValidation!.ok ? prefixValidation!.value : initialPrefix;

    if (selectedMode === 'fromDate') {
      onConfirm({ mode: 'fromDate', customStartDate: midnightLocal(fromDate), prefix: prefixOut });
    } else if (selectedMode === 'newOnly') {
      onConfirm({ mode: 'newOnly', customStartDate: null, prefix: prefixOut });
    } else {
      onConfirm({ mode: 'all', customStartDate: null, prefix: prefixOut });
    }
  }

  const modeOk = selectedMode !== undefined;
  const confirmEnabled = modeOk && prefixOk;

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

      {/* Prefix block — only rendered when includePrefix is true (first-enable path) */}
      {includePrefix && (
        <View
          style={[
            styles.prefixSection,
            { borderTopColor: colors.border },
          ]}>
          <ThemedText style={[Type.label, { color: colors.muted }]}>Folder prefix</ThemedText>
          <TextInput
            value={prefixDraft}
            onChangeText={setPrefixDraft}
            placeholder="auto/"
            placeholderTextColor={colors.muted}
            autoCapitalize="none"
            autoCorrect={false}
            style={[
              styles.prefixInput,
              {
                color: colors.text,
                backgroundColor: colors.surfaceMuted,
                borderColor: prefixValidation && !prefixValidation.ok ? colors.danger : colors.border,
              },
            ]}
          />
          {prefixValidation && !prefixValidation.ok ? (
            <ThemedText style={[Type.meta, { color: colors.danger }]}>
              {prefixValidation.error}
            </ThemedText>
          ) : (
            <View
              style={[
                styles.prefixPreview,
                { backgroundColor: colors.surfaceMuted, borderColor: colors.border },
              ]}>
              <ThemedText style={[Type.meta, { color: colors.muted }]}>Preview</ThemedText>
              <ThemedText
                style={[Type.meta, { color: colors.text, fontWeight: '600' }]}
                numberOfLines={2}>
                {prefixValidation && prefixValidation.ok
                  ? (prefixValidation.value
                    ? `${prefixValidation.value}${todayDateString()}/IMG_0001.jpg`
                    : `${todayDateString()}/IMG_0001.jpg`)
                  : `${todayDateString()}/IMG_0001.jpg`}
              </ThemedText>
            </View>
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
  prefixSection: {
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingTop: Spacing.md,
    gap: Spacing.sm,
  },
  prefixInput: {
    borderRadius: Radius.md,
    borderWidth: 1,
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm,
    fontSize: 16,
  },
  prefixPreview: {
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
  confirmBtn: {},
});
