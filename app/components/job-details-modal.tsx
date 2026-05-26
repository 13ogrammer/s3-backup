import React from 'react';
import {
  Pressable,
  ScrollView,
  StyleSheet,
  View,
} from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { ModalCard } from '@/components/ui/modal-card';
import { Colors, Radius, Spacing, Type } from '@/constants/theme';
import { useColorScheme } from '@/hooks/use-color-scheme';
import type { FolderMoveJobRecord, JobRecord } from '@/lib/api';
import { basename } from '@/lib/format';

type Props = {
  job: JobRecord;
  visible: boolean;
  onClose: () => void;
  onDismiss: () => void;
  onRetryFailed: () => Promise<void>;
};

export function JobDetailsModal({ job, visible, onClose, onDismiss, onRetryFailed }: Props) {
  const colorScheme = useColorScheme() ?? 'light';
  const colors = Colors[colorScheme];

  const isTerminal =
    job.status === 'completed' ||
    job.status === 'completed-with-errors' ||
    job.status === 'cancelled' ||
    job.status === 'failed';

  function statusLabel(): string {
    switch (job.status) {
      case 'queued': return 'Queued';
      case 'running': return 'Running';
      case 'completed': return 'Completed';
      case 'completed-with-errors': return 'Completed with errors';
      case 'cancelled': return 'Cancelled';
      case 'failed': return 'Failed';
    }
  }

  const statusColor =
    job.status === 'completed'
      ? colors.tint
      : job.status === 'completed-with-errors' || job.status === 'failed' || job.status === 'cancelled'
      ? colors.danger
      : colors.muted;

  if (job.kind === 'video-transcode') {
    return (
      <ModalCard visible={visible} onRequestClose={onClose} title="Generating preview">
        <View style={styles.section}>
          <ThemedText style={[Type.meta, { color: colors.muted }]}>File</ThemedText>
          <ThemedText style={[Type.label, { color: colors.text }]} numberOfLines={2}>
            {basename(job.key)}
          </ThemedText>
        </View>
        <View style={styles.section}>
          <ThemedText style={[Type.meta, { color: colors.muted }]}>Status</ThemedText>
          <ThemedText style={[Type.label, { color: statusColor }]}>{statusLabel()}</ThemedText>
        </View>
        {job.error && (
          <View style={styles.section}>
            <ThemedText style={[Type.meta, { color: colors.danger }]}>{job.error}</ThemedText>
          </View>
        )}
        <View style={styles.actions}>
          <Pressable
            onPress={onClose}
            style={({ pressed }) => [styles.btn, { opacity: pressed ? 0.6 : 1 }]}>
            <ThemedText style={[Type.label, { color: colors.muted }]}>Close</ThemedText>
          </Pressable>
          {isTerminal && (
            <Pressable
              onPress={onDismiss}
              style={({ pressed }) => [
                styles.btn,
                { backgroundColor: colors.surfaceMuted, opacity: pressed ? 0.6 : 1 },
              ]}>
              <ThemedText style={[Type.label, { color: colors.text }]}>Dismiss</ThemedText>
            </Pressable>
          )}
        </View>
      </ModalCard>
    );
  }

  // FolderMoveJobRecord path.
  const moveJob = job as FolderMoveJobRecord;
  const hasFailures = moveJob.failed.length > 0;
  const isMerge = moveJob.kind === 'merge';

  return (
    <ModalCard visible={visible} onRequestClose={onClose} title={isMerge ? 'Folder merge' : 'Folder move'}>
      <View style={styles.section}>
        <ThemedText style={[Type.meta, { color: colors.muted }]}>From</ThemedText>
        <ThemedText style={[Type.label, { color: colors.text }]} numberOfLines={2}>
          {moveJob.fromPrefix}
        </ThemedText>
      </View>
      <View style={styles.section}>
        <ThemedText style={[Type.meta, { color: colors.muted }]}>To</ThemedText>
        <ThemedText style={[Type.label, { color: colors.text }]} numberOfLines={2}>
          {moveJob.toPrefix}
        </ThemedText>
      </View>
      <View style={styles.section}>
        <ThemedText style={[Type.meta, { color: colors.muted }]}>Status</ThemedText>
        <ThemedText style={[Type.label, { color: statusColor }]}>
          {statusLabel()}
          {moveJob.total > 0 ? ` · ${moveJob.moved} / ${moveJob.total}` : ''}
        </ThemedText>
        {isMerge && (moveJob.renamed !== undefined || moveJob.skipped !== undefined) && (
          <ThemedText style={[Type.meta, { color: colors.muted, marginTop: 2 }]}>
            {[
              moveJob.renamed !== undefined && moveJob.renamed > 0 ? `${moveJob.renamed} renamed` : null,
              moveJob.skipped !== undefined && moveJob.skipped > 0 ? `${moveJob.skipped} skipped` : null,
            ]
              .filter(Boolean)
              .join(' · ')}
          </ThemedText>
        )}
      </View>

      {moveJob.error && (
        <View style={styles.section}>
          <ThemedText style={[Type.meta, { color: colors.danger }]}>{moveJob.error}</ThemedText>
        </View>
      )}

      {hasFailures && (
        <View style={styles.section}>
          <ThemedText style={[Type.label, { color: colors.danger, marginBottom: Spacing.xs }]}>
            {moveJob.failed.length} failed item{moveJob.failed.length !== 1 ? 's' : ''}
          </ThemedText>
          <ScrollView style={styles.failureList} nestedScrollEnabled>
            {moveJob.failed.map((f) => (
              <View key={f.key} style={[styles.failureRow, { borderBottomColor: colors.divider }]}>
                <ThemedText style={[Type.meta, { color: colors.text }]} numberOfLines={1}>
                  {f.key.split('/').pop() ?? f.key}
                </ThemedText>
                <ThemedText style={[Type.meta, { color: colors.muted }]} numberOfLines={1}>
                  {f.reason}
                </ThemedText>
              </View>
            ))}
          </ScrollView>
        </View>
      )}

      <View style={styles.actions}>
        <Pressable
          onPress={onClose}
          style={({ pressed }) => [styles.btn, { opacity: pressed ? 0.6 : 1 }]}>
          <ThemedText style={[Type.label, { color: colors.muted }]}>Close</ThemedText>
        </Pressable>
        {isTerminal && hasFailures && (
          <Pressable
            onPress={onRetryFailed}
            style={({ pressed }) => [
              styles.btn,
              styles.primaryBtn,
              { backgroundColor: colors.tint, opacity: pressed ? 0.7 : 1 },
            ]}>
            <ThemedText style={[Type.label, { color: colors.onAccent }]}>Retry failed</ThemedText>
          </Pressable>
        )}
        {isTerminal && (
          <Pressable
            onPress={onDismiss}
            style={({ pressed }) => [
              styles.btn,
              { backgroundColor: colors.surfaceMuted, opacity: pressed ? 0.6 : 1 },
            ]}>
            <ThemedText style={[Type.label, { color: colors.text }]}>Dismiss</ThemedText>
          </Pressable>
        )}
      </View>
    </ModalCard>
  );
}

const styles = StyleSheet.create({
  section: {
    gap: 2,
    marginBottom: Spacing.sm,
  },
  failureList: {
    maxHeight: 180,
  },
  failureRow: {
    paddingVertical: Spacing.xs,
    borderBottomWidth: StyleSheet.hairlineWidth,
    gap: 2,
  },
  actions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: Spacing.sm,
    marginTop: Spacing.md,
    flexWrap: 'wrap',
  },
  btn: {
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm,
    borderRadius: Radius.md,
  },
  primaryBtn: {
    // backgroundColor set inline
  },
});
