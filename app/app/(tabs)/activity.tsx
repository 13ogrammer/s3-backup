import * as Clipboard from 'expo-clipboard';
import { getInfoAsync } from 'expo-file-system/legacy';
import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
} from 'react-native';

import { useAiFabClearance } from '@/components/ai-fab';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { IconSymbol } from '@/components/ui/icon-symbol';
import { useAlert } from '@/components/ui/alert-provider';
import { Colors, Radius, Spacing, Type } from '@/constants/theme';
import { useColorScheme } from '@/hooks/use-color-scheme';
import { api } from '@/lib/api';
import { useJobs } from '@/lib/jobs';
import {
  clearActivity,
  fromErr,
  loadActivity,
  recordMoveFailure,
  recordUploadFailure,
  removeActivityEntry,
  removeUploadEntryByKey,
  toReason,
  type ActivityAutoBackupRunEntry,
  type ActivityEntry,
  type ActivityMoveEntry,
  type ActivityUploadEntry,
} from '@/lib/activityLog';
import { resumeUpload, runWithConcurrency } from '@/lib/upload';
import {
  loadPendingUploads,
  removePendingUpload,
  type PendingUpload,
} from '@/lib/uploadState';
import { setUploadSessionActive, useUploadSessionActive } from '@/lib/uploadSession';

// ---------------------------------------------------------------------------
// Day-label helper for History grouping
// ---------------------------------------------------------------------------

function dayLabel(timestampMs: number): string {
  const d = new Date(timestampMs);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);

  if (
    d.getFullYear() === today.getFullYear() &&
    d.getMonth() === today.getMonth() &&
    d.getDate() === today.getDate()
  ) {
    return 'Today';
  }
  if (
    d.getFullYear() === yesterday.getFullYear() &&
    d.getMonth() === yesterday.getMonth() &&
    d.getDate() === yesterday.getDate()
  ) {
    return 'Yesterday';
  }
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

type HistoryRow =
  | { type: 'dayHeader'; label: string }
  | { type: 'entry'; entry: ActivityUploadEntry | ActivityMoveEntry | ActivityAutoBackupRunEntry };

function buildHistoryRows(
  entries: Array<ActivityUploadEntry | ActivityMoveEntry | ActivityAutoBackupRunEntry>,
): HistoryRow[] {
  const rows: HistoryRow[] = [];
  let lastLabel = '';
  for (const entry of entries) {
    const label = dayLabel(entry.lastAt);
    if (label !== lastLabel) {
      rows.push({ type: 'dayHeader', label });
      lastLabel = label;
    }
    rows.push({ type: 'entry', entry });
  }
  return rows;
}

export default function ActivityScreen() {
  const colorScheme = useColorScheme() ?? 'light';
  const colors = Colors[colorScheme];
  const { showAlert } = useAlert();
  const { contentPaddingBottom } = useAiFabClearance();

  const { addJob } = useJobs();
  const [entries, setEntries] = useState<ActivityEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [liveLocalUriStatus, setLiveLocalUriStatus] = useState<Map<string, boolean>>(new Map());
  const [pendingByKey, setPendingByKey] = useState<Map<string, PendingUpload>>(new Map());
  const sessionActive = useUploadSessionActive();

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const loaded = await loadActivity();
      setEntries(loaded);

      const pending = await loadPendingUploads();
      const byKey = new Map<string, PendingUpload>();
      for (const p of pending) byKey.set(p.remoteKey, p);
      setPendingByKey(byKey);

      // Only check localUri existence for entries that actually have one.
      const uploadEntries = loaded.filter((e): e is ActivityUploadEntry => e.kind === 'upload');
      const statusMap = new Map<string, boolean>();
      await Promise.all(
        uploadEntries.map(async (e) => {
          if (!e.localUri) {
            statusMap.set(e.remoteKey, false);
            return;
          }
          try {
            const info = await getInfoAsync(e.localUri);
            statusMap.set(e.remoteKey, info.exists);
          } catch {
            statusMap.set(e.remoteKey, false);
          }
        }),
      );
      setLiveLocalUriStatus(statusMap);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useFocusEffect(
    useCallback(() => {
      refresh();
    }, [refresh]),
  );

  const uploadFailed = entries.filter(
    (e): e is ActivityUploadEntry => e.kind === 'upload' && e.status === 'failed',
  );
  const moveFailed = entries.filter(
    (e): e is ActivityMoveEntry => e.kind === 'move' && e.status === 'failed',
  );

  // History: successful uploads, successful moves, and all auto-backup runs.
  const historyEntries = entries.filter(
    (e): e is ActivityUploadEntry | ActivityMoveEntry | ActivityAutoBackupRunEntry =>
      (e.kind === 'upload' && e.status === 'success') ||
      (e.kind === 'move' && e.status === 'success') ||
      e.kind === 'autoBackupRun',
  );

  const historyRows = buildHistoryRows(historyEntries);

  async function onResumeUpload(entry: ActivityUploadEntry) {
    if (busy || sessionActive) return;
    const sourceOk = liveLocalUriStatus.get(entry.remoteKey);
    if (!sourceOk) return;
    const pending = pendingByKey.get(entry.remoteKey);
    if (!pending) return;

    setBusy(entry.remoteKey);
    try {
      setUploadSessionActive(true);
      await resumeUpload(pending);
      await removeUploadEntryByKey(entry.remoteKey);
      await refresh();
    } catch (err) {
      if (entry.localUri) {
        await recordUploadFailure({
          remoteKey: entry.remoteKey,
          localUri: entry.localUri,
          sizeBytes: entry.sizeBytes,
          ...fromErr(err),
        }).catch(() => undefined);
      }
      await refresh();
      showAlert('Resume failed', toReason(err));
    } finally {
      setUploadSessionActive(false);
      setBusy(null);
    }
  }

  async function onRemoveUpload(entry: ActivityUploadEntry) {
    await removeUploadEntryByKey(entry.remoteKey).catch(() => undefined);
    await removePendingUpload(entry.remoteKey).catch(() => undefined);
    await refresh();
  }

  async function onRetryMove(entry: ActivityMoveEntry) {
    if (busy || sessionActive) return;
    setBusy(entry.id);
    try {
      if (entry.itemKind === 'file') {
        await api.moveFile(entry.from, entry.to);
      } else {
        const res = await api.moveFolder(entry.from, entry.to);
        await addJob(res.jobId, { fromPrefix: entry.from, toPrefix: entry.to });
      }
      await removeActivityEntry(entry.id);
      await refresh();
    } catch (err) {
      await recordMoveFailure({
        from: entry.from,
        to: entry.to,
        itemKind: entry.itemKind,
        ...fromErr(err),
      }).catch(() => undefined);
      await refresh();
      showAlert('Retry failed', toReason(err));
    } finally {
      setBusy(null);
    }
  }

  async function onRemoveEntry(id: string) {
    await removeActivityEntry(id).catch(() => undefined);
    await refresh();
  }

  async function onRetryAllMoves() {
    if (busy || sessionActive) return;
    setBusy('moves');
    try {
      for (const entry of moveFailed) {
        try {
          if (entry.itemKind === 'file') {
            await api.moveFile(entry.from, entry.to);
          } else {
            const res = await api.moveFolder(entry.from, entry.to);
            await addJob(res.jobId, { fromPrefix: entry.from, toPrefix: entry.to });
          }
          await removeActivityEntry(entry.id).catch(() => undefined);
        } catch (err) {
          await recordMoveFailure({
            from: entry.from,
            to: entry.to,
            itemKind: entry.itemKind,
            ...fromErr(err),
          }).catch(() => undefined);
        }
      }
    } finally {
      setBusy(null);
      await refresh();
    }
  }

  async function onResumeAllUploads() {
    if (busy || sessionActive) return;
    const resumable = uploadFailed.filter(
      (e) => liveLocalUriStatus.get(e.remoteKey) && pendingByKey.has(e.remoteKey),
    );
    if (resumable.length === 0) return;

    setBusy('uploads');
    try {
      setUploadSessionActive(true);
      await runWithConcurrency(
        resumable,
        async (entry) => {
          const pending = pendingByKey.get(entry.remoteKey)!;
          try {
            await resumeUpload(pending);
            await removeUploadEntryByKey(entry.remoteKey).catch(() => undefined);
          } catch (err) {
            if (entry.localUri) {
              await recordUploadFailure({
                remoteKey: entry.remoteKey,
                localUri: entry.localUri,
                sizeBytes: entry.sizeBytes,
                ...fromErr(err),
              }).catch(() => undefined);
            }
            throw err;
          }
        },
        1,
      );
    } finally {
      setUploadSessionActive(false);
      setBusy(null);
      await refresh();
    }
  }

  function onClearAll() {
    showAlert(
      'Clear all activity?',
      'This removes all entries from the log. Pending uploads in the Gallery tab are not affected.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Clear all',
          style: 'destructive',
          onPress: async () => {
            await clearActivity().catch(() => undefined);
            await refresh();
          },
        },
      ],
    );
  }

  if (loading) {
    return (
      <ThemedView style={[styles.container, styles.center]}>
        <ActivityIndicator />
      </ThemedView>
    );
  }

  const isBusy = busy !== null;
  const needsAttention = uploadFailed.length > 0 || moveFailed.length > 0;
  const hasHistory = historyEntries.length > 0;
  const isEmpty = !needsAttention && !hasHistory;

  return (
    <ThemedView style={styles.container}>
      {needsAttention && (
        <View style={[styles.headerActions, { borderBottomColor: colors.border }]}>
          {moveFailed.length > 0 && (
            <Pressable
              accessibilityRole="button"
              disabled={isBusy || sessionActive}
              onPress={onRetryAllMoves}
              style={({ pressed }) => [
                styles.headerBtn,
                {
                  backgroundColor: colors.accentSoft,
                  opacity: pressed || isBusy || sessionActive ? 0.5 : 1,
                },
              ]}>
              <ThemedText style={[Type.label, { color: colors.tint }]}>Retry all moves</ThemedText>
            </Pressable>
          )}
          {uploadFailed.length > 0 && (
            <Pressable
              accessibilityRole="button"
              disabled={isBusy || sessionActive}
              onPress={onResumeAllUploads}
              style={({ pressed }) => [
                styles.headerBtn,
                {
                  backgroundColor: colors.accentSoft,
                  opacity: pressed || isBusy || sessionActive ? 0.5 : 1,
                },
              ]}>
              <ThemedText style={[Type.label, { color: colors.tint }]}>Resume all uploads</ThemedText>
            </Pressable>
          )}
          <Pressable
            accessibilityRole="button"
            onPress={onClearAll}
            style={({ pressed }) => [
              styles.headerBtn,
              { backgroundColor: colors.surfaceMuted, opacity: pressed ? 0.6 : 1 },
            ]}>
            <ThemedText style={[Type.label, { color: colors.danger }]}>Clear all</ThemedText>
          </Pressable>
        </View>
      )}

      {sessionActive && (
        <View style={[styles.sessionBanner, { backgroundColor: colors.accentSoft }]}>
          <ThemedText style={[Type.label, { color: colors.tint }]}>
            An upload is running in the Gallery tab — bulk actions are paused.
          </ThemedText>
        </View>
      )}

      {isEmpty ? (
        <View style={[styles.center, { flex: 1 }]}>
          <ThemedText style={[Type.body, { color: colors.muted, textAlign: 'center' }]}>
            You're all caught up.{'\n'}Failed uploads and moves will show up here.
          </ThemedText>
        </View>
      ) : (
        <ScrollView contentContainerStyle={{ paddingBottom: contentPaddingBottom }}>
          {needsAttention && (
            <>
              <View style={[styles.sectionHeader, { backgroundColor: colors.surfaceMuted }]}>
                <ThemedText style={[Type.label, { color: colors.muted }]}>
                  NEEDS ATTENTION
                </ThemedText>
              </View>

              {uploadFailed.map((item) => (
                <UploadRow
                  key={item.id}
                  entry={item}
                  sourceExists={liveLocalUriStatus.get(item.remoteKey) ?? false}
                  hasPending={pendingByKey.has(item.remoteKey)}
                  busy={busy === item.remoteKey}
                  sessionActive={sessionActive}
                  colors={colors}
                  expanded={expandedId === item.id}
                  onToggleExpand={() =>
                    setExpandedId((prev) => (prev === item.id ? null : item.id))
                  }
                  onResume={() => onResumeUpload(item)}
                  onRemove={() => onRemoveUpload(item)}
                  onCopyDetails={() => {
                    const lines = [
                      'Failure details',
                      '---------------',
                      'Type: upload',
                      `Reason: ${item.reason ?? '(no reason)'}`,
                      ...(item.failureStatus != null ? [`Status: ${item.failureStatus}`] : []),
                      ...(item.failureRequestId != null ? [`Request ID: ${item.failureRequestId}`] : []),
                      `Attempts: ${item.attempts}`,
                      `Last attempt: ${new Date(item.lastAt).toISOString()}`,
                      `Remote key: ${item.remoteKey}`,
                    ];
                    Clipboard.setStringAsync(lines.join('\n')).then(() => {
                      showAlert('Copied', 'Failure details copied to clipboard.');
                    }).catch(() => undefined);
                  }}
                />
              ))}

              {moveFailed.map((item) => (
                <MoveRow
                  key={item.id}
                  entry={item}
                  busy={busy === item.id}
                  sessionActive={sessionActive}
                  colors={colors}
                  expanded={expandedId === item.id}
                  onToggleExpand={() =>
                    setExpandedId((prev) => (prev === item.id ? null : item.id))
                  }
                  onRetry={() => onRetryMove(item)}
                  onRemove={() => onRemoveEntry(item.id)}
                  onCopyDetails={() => {
                    const lines = [
                      'Failure details',
                      '---------------',
                      'Type: move',
                      `Reason: ${item.reason ?? '(no reason)'}`,
                      ...(item.failureStatus != null ? [`Status: ${item.failureStatus}`] : []),
                      ...(item.failureRequestId != null ? [`Request ID: ${item.failureRequestId}`] : []),
                      `Attempts: ${item.attempts}`,
                      `Last attempt: ${new Date(item.lastAt).toISOString()}`,
                      `From: ${item.from}`,
                      `To: ${item.to}`,
                    ];
                    Clipboard.setStringAsync(lines.join('\n')).then(() => {
                      showAlert('Copied', 'Failure details copied to clipboard.');
                    }).catch(() => undefined);
                  }}
                />
              ))}
            </>
          )}

          {hasHistory && (
            <>
              <View style={[styles.sectionHeader, { backgroundColor: colors.surfaceMuted }]}>
                <ThemedText style={[Type.label, { color: colors.muted }]}>
                  HISTORY
                </ThemedText>
              </View>

              {historyRows.map((row, idx) => {
                if (row.type === 'dayHeader') {
                  return (
                    <View key={`day-${idx}`} style={styles.dayHeader}>
                      <ThemedText style={[Type.meta, { color: colors.muted }]}>
                        {row.label}
                      </ThemedText>
                    </View>
                  );
                }
                const { entry } = row;
                if (entry.kind === 'upload') {
                  return (
                    <UploadSuccessRow
                      key={entry.id}
                      entry={entry}
                      colors={colors}
                    />
                  );
                }
                if (entry.kind === 'move') {
                  return (
                    <MoveSuccessRow
                      key={entry.id}
                      entry={entry}
                      colors={colors}
                    />
                  );
                }
                return (
                  <AutoBackupRunRow
                    key={entry.id}
                    entry={entry}
                    colors={colors}
                  />
                );
              })}
            </>
          )}
        </ScrollView>
      )}
    </ThemedView>
  );
}

type UploadRowProps = {
  entry: ActivityUploadEntry;
  sourceExists: boolean;
  hasPending: boolean;
  busy: boolean;
  sessionActive: boolean;
  colors: (typeof Colors)['light'];
  expanded: boolean;
  onToggleExpand: () => void;
  onResume: () => void;
  onRemove: () => void;
  onCopyDetails: () => void;
};

function UploadRow({
  entry,
  sourceExists,
  hasPending,
  busy,
  sessionActive,
  colors,
  expanded,
  onToggleExpand,
  onResume,
  onRemove,
  onCopyDetails,
}: UploadRowProps) {
  const filename = entry.remoteKey.includes('/')
    ? entry.remoteKey.slice(entry.remoteKey.lastIndexOf('/') + 1)
    : entry.remoteKey;

  const canResume = sourceExists && hasPending;
  const disabled = busy || sessionActive;

  return (
    <View style={[styles.row, { backgroundColor: colors.surface }]}>
      <View style={{ flex: 1, gap: Spacing.xs }}>
        <ThemedText style={[Type.bodyStrong, { color: colors.text }]} numberOfLines={1}>
          {filename}
        </ThemedText>
        {!sourceExists ? (
          <ThemedText style={[Type.meta, { color: colors.muted }]}>Source missing</ThemedText>
        ) : !hasPending ? (
          <ThemedText style={[Type.meta, { color: colors.muted }]}>
            No resume state — re-upload from Gallery
          </ThemedText>
        ) : null}
        {!expanded && entry.reason != null && (
          <ThemedText style={[Type.meta, { color: colors.muted }]} numberOfLines={2}>
            {entry.reason}
          </ThemedText>
        )}
        {!expanded && (
          <ThemedText style={[Type.meta, { color: colors.muted }]}>
            {entry.attempts} attempt{entry.attempts !== 1 ? 's' : ''}
            {' · '}
            {new Date(entry.lastAt).toLocaleString()}
          </ThemedText>
        )}
        {expanded && (
          <View
            style={[
              styles.detailPanel,
              { borderTopColor: colors.border },
            ]}>
            {entry.reason != null && (
              <ThemedText style={[Type.meta, { color: colors.muted }]}>
                {entry.reason}
              </ThemedText>
            )}
            {entry.failureStatus != null && (
              <ThemedText style={[Type.meta, { color: colors.muted }]}>
                Status: {entry.failureStatus}
              </ThemedText>
            )}
            {entry.failureRequestId != null && (
              <ThemedText style={[Type.meta, { color: colors.muted }]}>
                Request ID: {entry.failureRequestId}
              </ThemedText>
            )}
            <ThemedText style={[Type.meta, { color: colors.muted }]}>
              Attempts: {entry.attempts}
            </ThemedText>
            <ThemedText style={[Type.meta, { color: colors.muted }]}>
              Last attempt: {new Date(entry.lastAt).toISOString()}
            </ThemedText>
            <Pressable
              accessibilityRole="button"
              onPress={onCopyDetails}
              style={({ pressed }) => [
                styles.actionChip,
                { backgroundColor: colors.surfaceMuted, opacity: pressed ? 0.6 : 1, alignSelf: 'flex-start' },
              ]}>
              <ThemedText style={[Type.label, { color: colors.tint }]}>Copy details</ThemedText>
            </Pressable>
          </View>
        )}
      </View>
      <View style={styles.rowActions}>
        {canResume && (
          <Pressable
            accessibilityRole="button"
            disabled={disabled}
            onPress={onResume}
            style={({ pressed }) => [
              styles.actionChip,
              {
                backgroundColor: colors.tint,
                opacity: pressed || disabled ? 0.5 : 1,
              },
            ]}>
            <ThemedText style={[Type.label, { color: colors.onAccent }]}>
              {busy ? '…' : 'Resume'}
            </ThemedText>
          </Pressable>
        )}
        <Pressable
          accessibilityRole="button"
          onPress={onRemove}
          style={({ pressed }) => [
            styles.actionChip,
            { backgroundColor: colors.surfaceMuted, opacity: pressed ? 0.6 : 1 },
          ]}>
          <ThemedText style={[Type.label, { color: colors.danger }]}>Remove</ThemedText>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={expanded ? 'Hide details' : 'Show details'}
          accessibilityState={{ expanded }}
          hitSlop={8}
          onPress={onToggleExpand}
          style={({ pressed }) => [
            styles.actionChip,
            { backgroundColor: colors.surfaceMuted, opacity: pressed ? 0.6 : 1 },
          ]}>
          <IconSymbol
            name="chevron.right"
            size={14}
            color={colors.muted}
            style={{ transform: [{ rotate: expanded ? '90deg' : '0deg' }] }}
          />
        </Pressable>
      </View>
    </View>
  );
}

type MoveRowProps = {
  entry: ActivityMoveEntry;
  busy: boolean;
  sessionActive: boolean;
  colors: (typeof Colors)['light'];
  expanded: boolean;
  onToggleExpand: () => void;
  onRetry: () => void;
  onRemove: () => void;
  onCopyDetails: () => void;
};

function MoveRow({
  entry,
  busy,
  sessionActive,
  colors,
  expanded,
  onToggleExpand,
  onRetry,
  onRemove,
  onCopyDetails,
}: MoveRowProps) {
  const disabled = busy || sessionActive;
  return (
    <View style={[styles.row, { backgroundColor: colors.surface }]}>
      <View style={{ flex: 1, gap: Spacing.xs }}>
        <ThemedText style={[Type.bodyStrong, { color: colors.text }]} numberOfLines={1}>
          {entry.from.includes('/')
            ? entry.from.slice(entry.from.lastIndexOf('/') + 1) || entry.from
            : entry.from}
        </ThemedText>
        {!expanded && (
          <>
            <ThemedText style={[Type.meta, { color: colors.muted }]} numberOfLines={1}>
              → {entry.to}
            </ThemedText>
            <ThemedText style={[Type.meta, { color: colors.muted }]} numberOfLines={2}>
              {entry.reason}
            </ThemedText>
            <ThemedText style={[Type.meta, { color: colors.muted }]}>
              {entry.attempts} attempt{entry.attempts !== 1 ? 's' : ''}
              {' · '}
              {new Date(entry.lastAt).toLocaleString()}
            </ThemedText>
          </>
        )}
        {expanded && (
          <View
            style={[
              styles.detailPanel,
              { borderTopColor: colors.border },
            ]}>
            <ThemedText style={[Type.meta, { color: colors.muted }]}>
              {entry.reason}
            </ThemedText>
            {entry.failureStatus != null && (
              <ThemedText style={[Type.meta, { color: colors.muted }]}>
                Status: {entry.failureStatus}
              </ThemedText>
            )}
            {entry.failureRequestId != null && (
              <ThemedText style={[Type.meta, { color: colors.muted }]}>
                Request ID: {entry.failureRequestId}
              </ThemedText>
            )}
            <ThemedText style={[Type.meta, { color: colors.muted }]}>
              Attempts: {entry.attempts}
            </ThemedText>
            <ThemedText style={[Type.meta, { color: colors.muted }]}>
              Last attempt: {new Date(entry.lastAt).toISOString()}
            </ThemedText>
            <ThemedText style={[Type.meta, { color: colors.muted }]}>
              {entry.from} → {entry.to}
            </ThemedText>
            <Pressable
              accessibilityRole="button"
              onPress={onCopyDetails}
              style={({ pressed }) => [
                styles.actionChip,
                { backgroundColor: colors.surfaceMuted, opacity: pressed ? 0.6 : 1, alignSelf: 'flex-start' },
              ]}>
              <ThemedText style={[Type.label, { color: colors.tint }]}>Copy details</ThemedText>
            </Pressable>
          </View>
        )}
      </View>
      <View style={styles.rowActions}>
        <Pressable
          accessibilityRole="button"
          disabled={disabled}
          onPress={onRetry}
          style={({ pressed }) => [
            styles.actionChip,
            {
              backgroundColor: colors.tint,
              opacity: pressed || disabled ? 0.5 : 1,
            },
          ]}>
          <ThemedText style={[Type.label, { color: colors.onAccent }]}>
            {busy ? '…' : 'Retry'}
          </ThemedText>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          onPress={onRemove}
          style={({ pressed }) => [
            styles.actionChip,
            { backgroundColor: colors.surfaceMuted, opacity: pressed ? 0.6 : 1 },
          ]}>
          <ThemedText style={[Type.label, { color: colors.danger }]}>Remove</ThemedText>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={expanded ? 'Hide details' : 'Show details'}
          accessibilityState={{ expanded }}
          hitSlop={8}
          onPress={onToggleExpand}
          style={({ pressed }) => [
            styles.actionChip,
            { backgroundColor: colors.surfaceMuted, opacity: pressed ? 0.6 : 1 },
          ]}>
          <IconSymbol
            name="chevron.right"
            size={14}
            color={colors.muted}
            style={{ transform: [{ rotate: expanded ? '90deg' : '0deg' }] }}
          />
        </Pressable>
      </View>
    </View>
  );
}

// ---------------------------------------------------------------------------
// History row components — muted palette, distinct icons
// ---------------------------------------------------------------------------

type UploadSuccessRowProps = {
  entry: ActivityUploadEntry;
  colors: (typeof Colors)['light'];
};

function UploadSuccessRow({ entry, colors }: UploadSuccessRowProps) {
  const filename = entry.remoteKey.includes('/')
    ? entry.remoteKey.slice(entry.remoteKey.lastIndexOf('/') + 1)
    : entry.remoteKey;

  return (
    <View style={[styles.historyRow, { backgroundColor: colors.surface }]}>
      <IconSymbol name="checkmark.circle" size={18} color={colors.success} style={styles.historyIcon} />
      <View style={{ flex: 1, gap: Spacing.xs }}>
        <ThemedText style={[Type.label, { color: colors.text }]} numberOfLines={1}>
          {filename}
        </ThemedText>
        <ThemedText style={[Type.meta, { color: colors.muted }]}>
          Uploaded · {new Date(entry.lastAt).toLocaleString()}
        </ThemedText>
      </View>
    </View>
  );
}

type MoveSuccessRowProps = {
  entry: ActivityMoveEntry;
  colors: (typeof Colors)['light'];
};

function MoveSuccessRow({ entry, colors }: MoveSuccessRowProps) {
  const name = entry.from.includes('/')
    ? entry.from.slice(entry.from.lastIndexOf('/') + 1) || entry.from
    : entry.from;

  const label = entry.itemKind === 'folder' ? 'Folder move started' : 'Moved';

  return (
    <View style={[styles.historyRow, { backgroundColor: colors.surface }]}>
      <IconSymbol name="arrow.right.circle" size={18} color={colors.success} style={styles.historyIcon} />
      <View style={{ flex: 1, gap: Spacing.xs }}>
        <ThemedText style={[Type.label, { color: colors.text }]} numberOfLines={1}>
          {name}
        </ThemedText>
        <ThemedText style={[Type.meta, { color: colors.muted }]} numberOfLines={1}>
          {label} → {entry.to}
        </ThemedText>
        <ThemedText style={[Type.meta, { color: colors.muted }]}>
          {new Date(entry.lastAt).toLocaleString()}
        </ThemedText>
      </View>
    </View>
  );
}

type AutoBackupRunRowProps = {
  entry: ActivityAutoBackupRunEntry;
  colors: (typeof Colors)['light'];
};

function AutoBackupRunRow({ entry, colors }: AutoBackupRunRowProps) {
  const failed = entry.status === 'failed';
  const iconColor = failed ? colors.danger : colors.success;
  const parts: string[] = [];
  if (entry.uploadedCount > 0) parts.push(`${entry.uploadedCount} uploaded`);
  if (entry.skippedCount > 0) parts.push(`${entry.skippedCount} skipped`);
  if (entry.failedCount > 0) parts.push(`${entry.failedCount} failed`);
  const summary = parts.length > 0 ? parts.join(', ') : 'No new photos';
  // Prefix failed runs so the error state is visible now that the per-row dismiss is gone.
  const summaryText = failed ? `Run completed with errors · ${summary}` : summary;

  return (
    <View style={[styles.historyRow, { backgroundColor: colors.surface }]}>
      <IconSymbol name="icloud.and.arrow.up" size={18} color={iconColor} style={styles.historyIcon} />
      <View style={{ flex: 1, gap: Spacing.xs }}>
        <ThemedText style={[Type.label, { color: colors.text }]}>
          Auto-backup run
        </ThemedText>
        <ThemedText style={[Type.meta, { color: failed ? colors.danger : colors.muted }]}>
          {summaryText}
        </ThemedText>
        <ThemedText style={[Type.meta, { color: colors.muted }]}>
          {new Date(entry.completedAt).toLocaleString()}
        </ThemedText>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  center: { alignItems: 'center', justifyContent: 'center', padding: Spacing.xl },
  headerActions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: Spacing.sm,
    padding: Spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  headerBtn: {
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm,
    borderRadius: Radius.md,
  },
  sessionBanner: {
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.sm,
  },
  sectionHeader: {
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.xs,
    marginTop: Spacing.md,
  },
  dayHeader: {
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.xs,
    marginTop: Spacing.sm,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: Spacing.md,
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.md,
    borderRadius: Radius.md,
    marginHorizontal: Spacing.md,
    marginTop: Spacing.sm,
  },
  historyRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.sm,
    borderRadius: Radius.md,
    marginHorizontal: Spacing.md,
    marginTop: Spacing.sm,
  },
  historyIcon: {
    flexShrink: 0,
  },
  rowActions: {
    gap: Spacing.xs,
    alignItems: 'flex-end',
    justifyContent: 'flex-start',
    paddingTop: Spacing.xs,
  },
  actionChip: {
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.xs,
    borderRadius: Radius.md,
  },
  detailPanel: {
    marginTop: Spacing.sm,
    paddingTop: Spacing.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    gap: Spacing.xs,
  },
});
