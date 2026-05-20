import React, { useEffect, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ThemedText } from '@/components/themed-text';
import { IconSymbol } from '@/components/ui/icon-symbol';
import { Colors, Radius, Shadow, Spacing, Type } from '@/constants/theme';
import { useColorScheme } from '@/hooks/use-color-scheme';
import { useJobs } from '@/lib/jobs';
import { JobDetailsModal } from '@/components/job-details-modal';
import type { JobRecord } from '@/lib/api';

// This must match the height configured in app/(tabs)/_layout.tsx so the strip
// sits flush above the tab bar without reshaping it.
export const TAB_BAR_CONTENT_HEIGHT = 48;

const AUTO_DISMISS_DELAY_MS = 4000;

export function JobsStrip() {
  const colorScheme = useColorScheme() ?? 'light';
  const colors = Colors[colorScheme];
  const insets = useSafeAreaInsets();
  const { activeJobs, cancelJob, dismissJob, retryFailed } = useJobs();
  const [detailsJob, setDetailsJob] = useState<JobRecord | null>(null);

  // Auto-dismiss completed / cancelled jobs after a short dwell.
  useEffect(() => {
    const terminalIds = activeJobs
      .filter(
        (j) =>
          j.status === 'completed' ||
          j.status === 'cancelled' ||
          j.status === 'failed',
      )
      .map((j) => j.jobId);

    if (terminalIds.length === 0) return;

    const timers = terminalIds.map((id) =>
      setTimeout(() => dismissJob(id), AUTO_DISMISS_DELAY_MS),
    );
    return () => timers.forEach(clearTimeout);
  }, [activeJobs, dismissJob]);

  if (activeJobs.length === 0) return null;

  const bottomOffset = insets.bottom + TAB_BAR_CONTENT_HEIGHT + 4;

  return (
    <>
      <View
        style={[
          styles.strip,
          {
            backgroundColor: colors.surfaceElevated,
            bottom: bottomOffset,
            ...Shadow.cardElevated,
          },
        ]}>
        {activeJobs.map((job) => (
          <JobRow
            key={job.jobId}
            job={job}
            colors={colors}
            onCancel={() => cancelJob(job.jobId)}
            onTap={() => setDetailsJob(job)}
          />
        ))}
      </View>

      {detailsJob && (
        <JobDetailsModal
          job={detailsJob}
          visible
          onClose={() => setDetailsJob(null)}
          onDismiss={() => {
            setDetailsJob(null);
            dismissJob(detailsJob.jobId);
          }}
          onRetryFailed={async () => {
            setDetailsJob(null);
            await retryFailed(detailsJob.jobId);
          }}
        />
      )}
    </>
  );
}

function JobRow({
  job,
  colors,
  onCancel,
  onTap,
}: {
  job: JobRecord;
  colors: (typeof Colors)['light'];
  onCancel: () => void;
  onTap: () => void;
}) {
  const pct = job.total > 0 ? Math.round((job.moved / job.total) * 100) : 0;
  const isRunning = job.status === 'queued' || job.status === 'running';
  const isCompleted = job.status === 'completed';
  const isWithErrors = job.status === 'completed-with-errors';
  const isCancelled = job.status === 'cancelled';
  const isFailed = job.status === 'failed';

  const fromName = job.fromPrefix.replace(/\/$/, '').split('/').pop() ?? job.fromPrefix;
  const toName = job.toPrefix.replace(/\/$/, '').split('/').pop() ?? job.toPrefix;

  let statusText: string;
  if (isCompleted) statusText = 'Complete';
  else if (isWithErrors) statusText = 'Done with errors';
  else if (isCancelled) statusText = 'Cancelled';
  else if (isFailed) statusText = job.error ?? 'Failed';
  else statusText = `${job.moved} / ${job.total > 0 ? job.total : '?'} · ${pct}%`;

  return (
    <Pressable
      onPress={onTap}
      style={({ pressed }) => [styles.row, { opacity: pressed ? 0.7 : 1 }]}>
      <View style={{ flex: 1, gap: 2 }}>
        <ThemedText style={[Type.label, { color: colors.text }]} numberOfLines={1}>
          {fromName} → {toName}
        </ThemedText>
        <View style={styles.progressRow}>
          {isRunning && job.total > 0 && (
            <View style={[styles.progressTrack, { backgroundColor: colors.border }]}>
              <View
                style={[
                  styles.progressFill,
                  { backgroundColor: colors.tint, width: `${pct}%` },
                ]}
              />
            </View>
          )}
          <ThemedText
            style={[
              Type.meta,
              {
                color: isCompleted
                  ? colors.tint
                  : isWithErrors || isCancelled || isFailed
                  ? colors.danger
                  : colors.muted,
              },
            ]}>
            {statusText}
          </ThemedText>
        </View>
      </View>
      {isRunning && (
        <Pressable
          onPress={(e) => {
            e.stopPropagation();
            onCancel();
          }}
          hitSlop={8}
          accessibilityLabel="Cancel job"
          style={({ pressed }) => [
            styles.cancelBtn,
            { backgroundColor: colors.surfaceMuted, opacity: pressed ? 0.6 : 1 },
          ]}>
          <IconSymbol name="xmark" size={12} color={colors.danger} />
        </Pressable>
      )}
      {(isWithErrors) && (
        <View
          style={[styles.badge, { backgroundColor: colors.danger }]}>
          <ThemedText style={[Type.meta, { color: '#fff', fontSize: 10 }]}>
            !
          </ThemedText>
        </View>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  strip: {
    position: 'absolute',
    left: Spacing.sm,
    right: Spacing.sm,
    borderRadius: Radius.lg,
    overflow: 'hidden',
    zIndex: 100,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm,
  },
  progressRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.xs,
  },
  progressTrack: {
    flex: 1,
    height: 3,
    borderRadius: 2,
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
    borderRadius: 2,
  },
  cancelBtn: {
    width: 24,
    height: 24,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badge: {
    width: 18,
    height: 18,
    borderRadius: 9,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
