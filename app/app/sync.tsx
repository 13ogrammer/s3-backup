import { getInfoAsync } from 'expo-file-system/legacy';
import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  SectionList,
  StyleSheet,
  View,
} from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { useAlert } from '@/components/ui/alert-provider';
import { Colors, Radius, Spacing, Type } from '@/constants/theme';
import { useColorScheme } from '@/hooks/use-color-scheme';
import { api } from '@/lib/api';
import {
  clearActivity,
  fromErr,
  loadActivity,
  recordMoveFailure,
  recordUploadFailure,
  removeActivityEntry,
  removeUploadEntryByKey,
  toReason,
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

type Section = {
  title: string;
  key: string;
  data: ActivityEntry[];
};

export default function ActivityScreen() {
  const colorScheme = useColorScheme() ?? 'light';
  const colors = Colors[colorScheme];
  const { showAlert } = useAlert();

  const [entries, setEntries] = useState<ActivityEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  // Map of remoteKey → file exists on device
  const [liveLocalUriStatus, setLiveLocalUriStatus] = useState<Map<string, boolean>>(new Map());
  // PendingUploads looked up by remoteKey
  const [pendingByKey, setPendingByKey] = useState<Map<string, PendingUpload>>(new Map());
  const sessionActive = useUploadSessionActive();

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const loaded = await loadActivity();
      setEntries(loaded);

      // Look up pending uploads once so Resume can find the right entry.
      const pending = await loadPendingUploads();
      const byKey = new Map<string, PendingUpload>();
      for (const p of pending) byKey.set(p.remoteKey, p);
      setPendingByKey(byKey);

      // Check whether each upload entry's source file still exists.
      const uploadEntries = loaded.filter((e): e is ActivityUploadEntry => e.kind === 'upload');
      const statusMap = new Map<string, boolean>();
      await Promise.all(
        uploadEntries.map(async (e) => {
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
  const moveFailed = entries.filter((e): e is ActivityMoveEntry => e.kind === 'move');

  const sections: Section[] = [];
  if (uploadFailed.length > 0) {
    sections.push({ title: 'Failed uploads', key: 'uploads', data: uploadFailed });
  }
  if (moveFailed.length > 0) {
    sections.push({ title: 'Failed moves', key: 'moves', data: moveFailed });
  }

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
      await recordUploadFailure({
        remoteKey: entry.remoteKey,
        localUri: entry.localUri,
        sizeBytes: entry.sizeBytes,
        ...fromErr(err),
      }).catch(() => undefined);
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
        await api.moveFolder(entry.from, entry.to);
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
            await api.moveFolder(entry.from, entry.to);
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
    // Only resume entries that have a matching PendingUpload and live source.
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
            await recordUploadFailure({
              remoteKey: entry.remoteKey,
              localUri: entry.localUri,
              sizeBytes: entry.sizeBytes,
              ...fromErr(err),
            }).catch(() => undefined);
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

  const hasEntries = entries.length > 0;
  const isBusy = busy !== null;

  return (
    <ThemedView style={styles.container}>
      {hasEntries && (
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

      {sections.length === 0 ? (
        <View style={[styles.center, { flex: 1 }]}>
          <ThemedText style={[Type.body, { color: colors.muted, textAlign: 'center' }]}>
            No activity yet.{'\n'}Failed uploads and moves will show up here.
          </ThemedText>
        </View>
      ) : (
        <SectionList<ActivityEntry, Section>
          sections={sections}
          keyExtractor={(item) => item.id}
          contentContainerStyle={{ paddingBottom: Spacing.xl }}
          stickySectionHeadersEnabled={false}
          renderSectionHeader={({ section }) => (
            <View style={[styles.sectionHeader, { backgroundColor: colors.surfaceMuted }]}>
              <ThemedText style={[Type.label, { color: colors.muted }]}>
                {section.title.toUpperCase()}
              </ThemedText>
            </View>
          )}
          renderItem={({ item }) => {
            if (item.kind === 'upload') {
              return (
                <UploadRow
                  entry={item}
                  sourceExists={liveLocalUriStatus.get(item.remoteKey) ?? false}
                  hasPending={pendingByKey.has(item.remoteKey)}
                  busy={busy === item.remoteKey}
                  sessionActive={sessionActive}
                  colors={colors}
                  onResume={() => onResumeUpload(item)}
                  onRemove={() => onRemoveUpload(item)}
                />
              );
            }
            return (
              <MoveRow
                entry={item}
                busy={busy === item.id}
                sessionActive={sessionActive}
                colors={colors}
                onRetry={() => onRetryMove(item)}
                onRemove={() => onRemoveEntry(item.id)}
              />
            );
          }}
        />
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
  onResume: () => void;
  onRemove: () => void;
};

function UploadRow({
  entry,
  sourceExists,
  hasPending,
  busy,
  sessionActive,
  colors,
  onResume,
  onRemove,
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
        {entry.reason != null && (
          <ThemedText style={[Type.meta, { color: colors.muted }]} numberOfLines={2}>
            {entry.reason}
          </ThemedText>
        )}
        <ThemedText style={[Type.meta, { color: colors.muted }]}>
          {entry.attempts} attempt{entry.attempts !== 1 ? 's' : ''}
          {' · '}
          {new Date(entry.lastAt).toLocaleString()}
        </ThemedText>
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
      </View>
    </View>
  );
}

type MoveRowProps = {
  entry: ActivityMoveEntry;
  busy: boolean;
  sessionActive: boolean;
  colors: (typeof Colors)['light'];
  onRetry: () => void;
  onRemove: () => void;
};

function MoveRow({ entry, busy, sessionActive, colors, onRetry, onRemove }: MoveRowProps) {
  const disabled = busy || sessionActive;
  return (
    <View style={[styles.row, { backgroundColor: colors.surface }]}>
      <View style={{ flex: 1, gap: Spacing.xs }}>
        <ThemedText style={[Type.bodyStrong, { color: colors.text }]} numberOfLines={1}>
          {entry.from.includes('/')
            ? entry.from.slice(entry.from.lastIndexOf('/') + 1) || entry.from
            : entry.from}
        </ThemedText>
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
});
