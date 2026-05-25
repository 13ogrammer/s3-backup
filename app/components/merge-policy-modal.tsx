import React from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { ModalCard } from '@/components/ui/modal-card';
import { Colors, Radius, Spacing, Type } from '@/constants/theme';
import { useColorScheme } from '@/hooks/use-color-scheme';
import type { MergePolicy } from '@/lib/api';
import type { CollisionReport } from '@/lib/mergePrecheck';

type Props = {
  visible: boolean;
  fromPrefix: string;
  toPrefix: string;
  report: CollisionReport;
  onCancel: () => void;
  onChoose: (policy: MergePolicy) => void;
};

type PolicyOption = {
  policy: MergePolicy;
  label: string;
  description: string;
};

const POLICY_OPTIONS: PolicyOption[] = [
  {
    policy: 'replace',
    label: 'Replace all',
    description: 'Overwrite colliding files in the destination with files from the source.',
  },
  {
    policy: 'keepBoth',
    label: 'Keep both',
    description: 'Rename colliding source files as "name (1).ext" before moving.',
  },
  {
    policy: 'skip',
    label: 'Skip duplicates',
    description: 'Leave colliding destination files untouched; remove colliding source files.',
  },
];

export function MergePolicyModal({
  visible,
  fromPrefix,
  toPrefix,
  report,
  onCancel,
  onChoose,
}: Props) {
  const colorScheme = useColorScheme() ?? 'light';
  const colors = Colors[colorScheme];

  const fromName = fromPrefix.replace(/\/$/, '').split('/').pop() ?? fromPrefix;
  const toName = toPrefix.replace(/\/$/, '').split('/').pop() ?? toPrefix;

  const collisionCountLabel = report.truncated
    ? `${report.total}+ collisions`
    : `${report.total} collision${report.total !== 1 ? 's' : ''}`;

  return (
    <ModalCard
      visible={visible}
      onRequestClose={onCancel}
      title="Folder already exists"
      dismissOnBackdrop={false}>
      <ThemedText style={[Type.body, { color: colors.text }]}>
        <ThemedText style={{ fontWeight: '600' }}>{fromName}</ThemedText>
        {' cannot be merged into '}
        <ThemedText style={{ fontWeight: '600' }}>{toName}</ThemedText>
        {' without conflicts. '}
        <ThemedText style={{ color: colors.muted }}>{collisionCountLabel} found.</ThemedText>
      </ThemedText>

      {report.samples.length > 0 && (
        <View style={[styles.sampleBox, { backgroundColor: colors.surfaceMuted, borderColor: colors.border }]}>
          {report.samples.map((rel) => (
            <ThemedText
              key={rel}
              style={[Type.meta, { color: colors.muted }]}
              numberOfLines={1}>
              • {rel}
            </ThemedText>
          ))}
          {report.truncated && (
            <ThemedText style={[Type.meta, { color: colors.muted }]}>
              + more (scan was truncated)
            </ThemedText>
          )}
        </View>
      )}

      <ThemedText style={[Type.label, { color: colors.text, marginTop: Spacing.xs }]}>
        How should conflicts be handled?
      </ThemedText>

      {POLICY_OPTIONS.map((opt) => (
        <Pressable
          key={opt.policy}
          onPress={() => onChoose(opt.policy)}
          style={({ pressed }) => [
            styles.policyRow,
            {
              backgroundColor: pressed ? colors.accentSoft : colors.surface,
              borderColor: colors.border,
            },
          ]}>
          <ThemedText style={[Type.label, { color: colors.tint }]}>{opt.label}</ThemedText>
          <ThemedText style={[Type.meta, { color: colors.muted, marginTop: 2 }]}>
            {opt.description}
          </ThemedText>
        </Pressable>
      ))}

      <Pressable
        onPress={onCancel}
        style={({ pressed }) => [
          styles.cancelBtn,
          { opacity: pressed ? 0.6 : 1 },
        ]}>
        <ThemedText style={[Type.label, { color: colors.muted, textAlign: 'center' }]}>
          Cancel
        </ThemedText>
      </Pressable>
    </ModalCard>
  );
}

const styles = StyleSheet.create({
  sampleBox: {
    borderRadius: Radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    padding: Spacing.sm,
    gap: Spacing.xs,
  },
  policyRow: {
    borderRadius: Radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    padding: Spacing.md,
    gap: 2,
  },
  cancelBtn: {
    paddingVertical: Spacing.sm,
    marginTop: Spacing.xs,
  },
});
