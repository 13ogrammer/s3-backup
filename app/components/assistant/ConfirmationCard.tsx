import { Pressable, StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Colors, Radius, Shadow, Spacing, Type } from '@/constants/theme';
import { useColorScheme } from '@/hooks/use-color-scheme';
import type { PendingActionPayload } from '@/lib/assistantTools';

export type ConfirmationCardProps = {
  payload: PendingActionPayload;
  decision: 'awaiting' | 'approved' | 'rejected';
  outcome?: { kind: 'ok'; result: unknown } | { kind: 'error'; error: string };
  onApprove: () => void;
  onReject: () => void;
};

function actionLabel(payload: PendingActionPayload): string {
  return payload.kind === 'create_folder' ? 'Create folder' : 'Move';
}

function outcomeText(
  decision: 'awaiting' | 'approved' | 'rejected',
  outcome?: { kind: 'ok'; result: unknown } | { kind: 'error'; error: string },
): string | null {
  if (decision === 'awaiting') return null;
  if (decision === 'rejected') return 'Rejected';
  if (!outcome) return 'Approved — running…';
  if (outcome.kind === 'error') return `Failed: ${outcome.error}`;

  // Show a brief success summary from the result when available.
  if (outcome.kind === 'ok' && typeof outcome.result === 'object' && outcome.result !== null) {
    const res = outcome.result as Record<string, unknown>;
    if (typeof res.jobId === 'string') {
      return `Queued — job ${res.jobId.slice(0, 8)}…`;
    }
    if (res.ok === true) return 'Done';
    if (typeof res.moved === 'number') return `Moved ${res.moved} file(s)`;
  }
  return 'Done';
}

export function ConfirmationCard({
  payload,
  decision,
  outcome,
  onApprove,
  onReject,
}: ConfirmationCardProps) {
  const colorScheme = useColorScheme() ?? 'light';
  const colors = Colors[colorScheme];

  const status = outcomeText(decision, outcome);
  const statusColor =
    decision === 'rejected'
      ? colors.muted
      : outcome?.kind === 'error'
        ? colors.danger
        : colors.tint;

  return (
    <View
      style={[
        styles.container,
        { backgroundColor: colors.surfaceMuted, borderColor: colors.border },
        Shadow.card,
      ]}>
      <View style={styles.header}>
        <ThemedText style={[Type.label, { color: colors.muted }]}>
          {actionLabel(payload)}
        </ThemedText>
      </View>

      <ThemedText style={[Type.body, styles.summary, { color: colors.text }]}>
        {payload.summary}
      </ThemedText>

      {decision === 'awaiting' ? (
        <View style={styles.buttons}>
          <Pressable
            onPress={onReject}
            accessibilityRole="button"
            accessibilityLabel="Reject action"
            style={({ pressed }) => [
              styles.button,
              styles.rejectButton,
              { borderColor: colors.border, opacity: pressed ? 0.6 : 1 },
            ]}>
            <ThemedText style={[Type.label, { color: colors.text }]}>Reject</ThemedText>
          </Pressable>

          <Pressable
            onPress={onApprove}
            accessibilityRole="button"
            accessibilityLabel="Approve action"
            style={({ pressed }) => [
              styles.button,
              styles.approveButton,
              { backgroundColor: colors.tint, opacity: pressed ? 0.6 : 1 },
            ]}>
            <ThemedText style={[Type.label, { color: colors.onAccent }]}>Approve</ThemedText>
          </Pressable>
        </View>
      ) : (
        <ThemedText style={[Type.meta, styles.statusLine, { color: statusColor }]}>
          {status}
        </ThemedText>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    marginHorizontal: Spacing.lg,
    marginBottom: Spacing.sm,
    borderRadius: Radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
    padding: Spacing.md,
    gap: Spacing.sm,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  summary: {
    // No extra styles; uses Type.body from the parent
  },
  buttons: {
    flexDirection: 'row',
    gap: Spacing.sm,
    marginTop: Spacing.xs,
  },
  button: {
    flex: 1,
    // Minimum 44px tap target per BA acceptance criteria.
    minHeight: 44,
    borderRadius: Radius.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rejectButton: {
    borderWidth: StyleSheet.hairlineWidth,
  },
  approveButton: {
    // backgroundColor supplied inline via colors.tint
  },
  statusLine: {
    marginTop: Spacing.xs,
  },
});
