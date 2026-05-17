import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
} from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Colors, Radius, Shadow, Spacing, Type } from '@/constants/theme';
import { useColorScheme } from '@/hooks/use-color-scheme';
import { api, type GetDerivedUrlResponse } from '@/lib/api';
import { appendAudit, clearAudit, loadAudit, type AuditEntry } from '@/lib/audit';
import { groupByEtag, pickKeepers, type DuplicateGroup, type ScanProgress, type ScannedFile } from '@/lib/duplicates';
import { basename, formatBytes } from '@/lib/format';

type ScanState = 'idle' | 'scanning' | 'done' | 'error';

// Per-group resolution chosen in-session (before applying).
type GroupDecision =
  | { kind: 'skip' }
  | { kind: 'keep-newest' }
  | { kind: 'keep-oldest' }
  | { kind: 'manual'; keepKey: string };

export default function DuplicatesScreen() {
  const colorScheme = useColorScheme() ?? 'light';
  const colors = Colors[colorScheme];

  const [scanState, setScanState] = useState<ScanState>('idle');
  const [scanError, setScanError] = useState<string | null>(null);
  const [progress, setProgress] = useState<ScanProgress>({
    pagesFetched: 0,
    filesScanned: 0,
    filesWithEtag: 0,
    filesSkippedMultipart: 0,
  });
  const [groups, setGroups] = useState<DuplicateGroup[]>([]);
  const [decisions, setDecisions] = useState<Map<string, GroupDecision>>(new Map());
  const [thumbCache, setThumbCache] = useState<Map<string, string>>(new Map());
  const [applying, setApplying] = useState(false);
  const [auditVisible, setAuditVisible] = useState(false);
  const [auditEntries, setAuditEntries] = useState<AuditEntry[]>([]);
  const [auditLoading, setAuditLoading] = useState(false);
  const cancelledRef = useRef(false);

  const pendingGroups = groups.filter((g) => {
    const d = decisions.get(g.id);
    return !d || d.kind !== 'skip';
  });
  const totalRecoverableBytes = pendingGroups.reduce((acc, g) => acc + g.recoverableBytes, 0);
  const totalDupeFiles = pendingGroups.reduce((acc, g) => acc + g.files.length - 1, 0);

  async function startScan() {
    cancelledRef.current = false;
    setScanState('scanning');
    setScanError(null);
    setGroups([]);
    setDecisions(new Map());
    setThumbCache(new Map());

    const prog: ScanProgress = {
      pagesFetched: 0,
      filesScanned: 0,
      filesWithEtag: 0,
      filesSkippedMultipart: 0,
    };
    setProgress(prog);

    const allFiles: ScannedFile[] = [];
    let continuationToken: string | undefined;

    try {
      do {
        if (cancelledRef.current) break;
        const res = await api.list({ recursive: true, continuationToken });
        prog.pagesFetched += 1;

        for (const f of res.files) {
          prog.filesScanned += 1;
          if (!f.etag) {
            // Either no ETag header or multipart — skip silently.
            prog.filesSkippedMultipart += 1;
            continue;
          }
          prog.filesWithEtag += 1;
          allFiles.push({
            key: f.key,
            size: f.size,
            lastModified: f.lastModified,
            kind: f.kind,
            etag: f.etag,
            previewUrl: f.previewUrl,
          });
        }

        setProgress({ ...prog });
        continuationToken = res.nextToken;
      } while (continuationToken);

      if (!cancelledRef.current) {
        const found = groupByEtag(allFiles);
        setGroups(found);
        setScanState('done');
      } else {
        setScanState('idle');
      }
    } catch (err) {
      setScanError(err instanceof Error ? err.message : 'Unknown error');
      setScanState('error');
    }
  }

  function cancelScan() {
    cancelledRef.current = true;
  }

  function setDecision(groupId: string, decision: GroupDecision) {
    setDecisions((prev) => {
      const next = new Map(prev);
      next.set(groupId, decision);
      return next;
    });
  }

  function ensureThumb(key: string, kind: 'image' | 'video' | 'other') {
    if (kind === 'other') return;
    if (thumbCache.has(key)) return;
    api
      .getDerivedUrl(key, 'thumbnail')
      .then((res) => {
        const url = (res as { url: string | null }).url;
        if (!url) return;
        setThumbCache((prev) => {
          if (prev.has(key)) return prev;
          const next = new Map(prev);
          next.set(key, (res as GetDerivedUrlResponse).url);
          return next;
        });
      })
      .catch(() => {});
  }

  async function applyDecision(group: DuplicateGroup, decision: GroupDecision) {
    if (decision.kind === 'skip') return;

    let keep: ScannedFile;
    let discard: ScannedFile[];

    if (decision.kind === 'keep-newest') {
      ({ keep, discard } = pickKeepers(group, 'newest'));
    } else if (decision.kind === 'keep-oldest') {
      ({ keep, discard } = pickKeepers(group, 'oldest'));
    } else {
      keep = group.files.find((f) => f.key === decision.keepKey)!;
      discard = group.files.filter((f) => f.key !== keep.key);
    }

    const strategy = decision.kind === 'keep-newest' ? 'newest' : decision.kind === 'keep-oldest' ? 'oldest' : 'manual';
    const discardKeys = discard.map((f) => f.key);
    const recoveredBytes = discard.reduce((acc, f) => acc + f.size, 0);

    const res = await api.delete({ keys: discardKeys });

    if (res.errors.length > 0) {
      const errList = res.errors
        .slice(0, 5)
        .map((e) => `• ${basename(e.key)}: ${e.message}`)
        .join('\n');
      Alert.alert(
        'Partial delete',
        `Deleted ${res.deleted.length} of ${discardKeys.length} duplicates.\n${res.errors.length} failed:\n${errList}`,
      );
    }

    if (res.deleted.length > 0) {
      await appendAudit({
        action: 'delete-duplicates',
        strategy,
        keptKey: keep.key,
        discardedKeys: res.deleted,
        recoveredBytes,
      });
    }

    return res;
  }

  async function runApplyGroup(group: DuplicateGroup, decision: GroupDecision) {
    setApplying(true);
    try {
      const res = await applyDecision(group, decision);
      if (res && res.errors.length === 0) {
        setGroups((prev) => prev.filter((g) => g.id !== group.id));
        setDecisions((prev) => {
          const next = new Map(prev);
          next.delete(group.id);
          return next;
        });
      }
    } catch (err) {
      Alert.alert('Delete failed', err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setApplying(false);
    }
  }

  function confirmApplyGroup(group: DuplicateGroup) {
    const decision = decisions.get(group.id);
    if (!decision || decision.kind === 'skip') {
      Alert.alert('No action selected', 'Choose Keep newest, Keep oldest, or Pick manually first.');
      return;
    }

    let { discard } = decision.kind === 'keep-newest'
      ? pickKeepers(group, 'newest')
      : decision.kind === 'keep-oldest'
      ? pickKeepers(group, 'oldest')
      : { discard: group.files.filter((f) => f.key !== (decision as { keepKey: string }).keepKey) };

    const bytes = discard.reduce((acc, f) => acc + f.size, 0);
    Alert.alert(
      'Delete duplicates?',
      `This will permanently delete ${discard.length} file(s) (${formatBytes(bytes)}). S3 versioning recommended.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () => runApplyGroup(group, decision),
        },
      ],
    );
  }

  function confirmBatchApply() {
    const actionable = pendingGroups.filter((g) => {
      const d = decisions.get(g.id);
      return d && d.kind !== 'skip';
    });

    // For groups with no explicit decision, default to keep-newest.
    const toProcess = pendingGroups.map((g) => ({
      group: g,
      decision: decisions.get(g.id) ?? ({ kind: 'keep-newest' } as GroupDecision),
    }));

    const fileCount = toProcess.reduce((acc, { group, decision }) => {
      if (decision.kind === 'skip') return acc;
      const { discard } =
        decision.kind === 'keep-newest'
          ? pickKeepers(group, 'newest')
          : decision.kind === 'keep-oldest'
          ? pickKeepers(group, 'oldest')
          : { discard: group.files.filter((f) => f.key !== (decision as { keepKey: string }).keepKey) };
      return acc + discard.length;
    }, 0);

    const bytes = toProcess.reduce((acc, { group, decision }) => {
      if (decision.kind === 'skip') return acc;
      const { discard } =
        decision.kind === 'keep-newest'
          ? pickKeepers(group, 'newest')
          : decision.kind === 'keep-oldest'
          ? pickKeepers(group, 'oldest')
          : { discard: group.files.filter((f) => f.key !== (decision as { keepKey: string }).keepKey) };
      return acc + discard.reduce((s, f) => s + f.size, 0);
    }, 0);

    Alert.alert(
      `Apply to all ${toProcess.length} group(s)?`,
      `Keeps newest in each group with no decision set.\nDeletes ${fileCount} file(s) (${formatBytes(bytes)}).`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Apply',
          style: 'destructive',
          onPress: () => runBatchApply(toProcess),
        },
      ],
    );
  }

  async function runBatchApply(
    items: Array<{ group: DuplicateGroup; decision: GroupDecision }>,
  ) {
    setApplying(true);
    const errors: string[] = [];
    const deletedGroupIds: string[] = [];

    for (const { group, decision } of items) {
      if (decision.kind === 'skip') continue;
      try {
        const res = await applyDecision(group, decision);
        if (res && res.errors.length === 0) {
          deletedGroupIds.push(group.id);
        } else if (res && res.errors.length > 0) {
          errors.push(`${basename(group.files[0]!.key)}: ${res.errors.length} error(s)`);
        }
      } catch (err) {
        errors.push(`${basename(group.files[0]!.key)}: ${err instanceof Error ? err.message : 'failed'}`);
      }
    }

    setGroups((prev) => prev.filter((g) => !deletedGroupIds.includes(g.id)));
    setDecisions((prev) => {
      const next = new Map(prev);
      for (const id of deletedGroupIds) next.delete(id);
      return next;
    });
    setApplying(false);

    if (errors.length > 0) {
      Alert.alert(
        'Batch complete with errors',
        `${deletedGroupIds.length} group(s) resolved. ${errors.length} failed:\n${errors.slice(0, 5).join('\n')}`,
      );
    }
  }

  async function openAuditLog() {
    setAuditLoading(true);
    setAuditVisible(true);
    try {
      const entries = await loadAudit();
      setAuditEntries(entries);
    } catch {
      setAuditEntries([]);
    } finally {
      setAuditLoading(false);
    }
  }

  function confirmClearAudit() {
    Alert.alert('Clear audit log?', 'This removes all recorded duplicate-resolution history.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Clear',
        style: 'destructive',
        onPress: async () => {
          await clearAudit();
          setAuditEntries([]);
        },
      },
    ]);
  }

  // ---- Render helpers ----

  function renderThumbStrip(group: DuplicateGroup) {
    return (
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginTop: Spacing.sm }}>
        <View style={styles.thumbStrip}>
          {group.files.map((f) => {
            const thumbUrl = thumbCache.get(f.key);
            if (!thumbUrl) {
              ensureThumb(f.key, f.kind);
            }
            return (
              <View key={f.key} style={[styles.thumbSlot, { backgroundColor: colors.surfaceMuted }]}>
                {thumbUrl ? (
                  <Image
                    source={{ uri: thumbUrl }}
                    style={styles.thumbImg}
                    contentFit="cover"
                    recyclingKey={f.key}
                  />
                ) : (
                  <Ionicons name="image-outline" size={22} color={colors.muted} />
                )}
              </View>
            );
          })}
        </View>
      </ScrollView>
    );
  }

  function renderGroupCard({ item: group }: { item: DuplicateGroup }) {
    const decision = decisions.get(group.id);
    const name = basename(group.files[0]!.key);

    return (
      <View style={[styles.card, { backgroundColor: colors.surface }, Shadow.card]}>
        <View style={styles.cardHeader}>
          <ThemedText style={[Type.bodyStrong, { color: colors.text, flex: 1 }]} numberOfLines={1}>
            {name}
          </ThemedText>
          <ThemedText style={[Type.meta, { color: colors.muted }]}>
            {group.files.length} copies · save {formatBytes(group.recoverableBytes)}
          </ThemedText>
        </View>

        {renderThumbStrip(group)}

        <View style={{ marginTop: Spacing.xs }}>
          {group.files.map((f) => (
            <View key={f.key} style={styles.fileRow}>
              <ThemedText style={[Type.meta, { color: colors.muted, flex: 1 }]} numberOfLines={1}>
                {f.key}
              </ThemedText>
              <ThemedText style={[Type.meta, { color: colors.muted }]}>
                {formatBytes(f.size)}
              </ThemedText>
            </View>
          ))}
        </View>

        <View style={styles.actionRow}>
          <Pressable
            onPress={() => setDecision(group.id, { kind: 'keep-newest' })}
            style={({ pressed }) => [
              styles.actionChip,
              {
                backgroundColor:
                  decision?.kind === 'keep-newest' ? colors.tint : colors.surfaceMuted,
                opacity: pressed ? 0.7 : 1,
              },
            ]}>
            <ThemedText
              style={[
                Type.meta,
                { color: decision?.kind === 'keep-newest' ? colors.onAccent : colors.text },
              ]}>
              Keep newest
            </ThemedText>
          </Pressable>
          <Pressable
            onPress={() => setDecision(group.id, { kind: 'keep-oldest' })}
            style={({ pressed }) => [
              styles.actionChip,
              {
                backgroundColor:
                  decision?.kind === 'keep-oldest' ? colors.tint : colors.surfaceMuted,
                opacity: pressed ? 0.7 : 1,
              },
            ]}>
            <ThemedText
              style={[
                Type.meta,
                { color: decision?.kind === 'keep-oldest' ? colors.onAccent : colors.text },
              ]}>
              Keep oldest
            </ThemedText>
          </Pressable>
          <Pressable
            onPress={() => showManualPicker(group)}
            style={({ pressed }) => [
              styles.actionChip,
              {
                backgroundColor:
                  decision?.kind === 'manual' ? colors.tint : colors.surfaceMuted,
                opacity: pressed ? 0.7 : 1,
              },
            ]}>
            <ThemedText
              style={[
                Type.meta,
                { color: decision?.kind === 'manual' ? colors.onAccent : colors.text },
              ]}>
              Pick manually
            </ThemedText>
          </Pressable>
          <Pressable
            onPress={() => setDecision(group.id, { kind: 'skip' })}
            style={({ pressed }) => [
              styles.actionChip,
              {
                backgroundColor:
                  decision?.kind === 'skip' ? colors.accentSoft : colors.surfaceMuted,
                opacity: pressed ? 0.7 : 1,
              },
            ]}>
            <ThemedText style={[Type.meta, { color: colors.tint }]}>Skip</ThemedText>
          </Pressable>
        </View>

        {decision && decision.kind !== 'skip' && (
          <Pressable
            onPress={() => confirmApplyGroup(group)}
            disabled={applying}
            style={({ pressed }) => [
              styles.applyButton,
              { backgroundColor: colors.danger, opacity: pressed || applying ? 0.7 : 1 },
            ]}>
            <ThemedText style={[Type.label, { color: colors.onAccent, fontWeight: '600' }]}>
              Apply — delete duplicates
            </ThemedText>
          </Pressable>
        )}
      </View>
    );
  }

  function showManualPicker(group: DuplicateGroup) {
    const options = group.files.map((f, i) => ({
      text: `Keep: ${basename(f.key)} (${new Date(f.lastModified).toLocaleDateString()})`,
      onPress: () => setDecision(group.id, { kind: 'manual', keepKey: f.key }),
    }));
    Alert.alert(
      'Pick which file to keep',
      'All others in this group will be deleted.',
      [...options, { text: 'Cancel', style: 'cancel' as const }],
    );
  }

  // ---- Main render ----

  if (auditVisible) {
    return (
      <ThemedView style={styles.container}>
        <View style={styles.auditHeader}>
          <Pressable onPress={() => setAuditVisible(false)} hitSlop={8}>
            <Ionicons name="arrow-back" size={22} color={colors.tint} />
          </Pressable>
          <ThemedText style={[Type.bodyStrong, { color: colors.text, flex: 1, marginLeft: Spacing.sm }]}>
            Audit log
          </ThemedText>
          <Pressable onPress={confirmClearAudit} hitSlop={8}>
            <ThemedText style={[Type.label, { color: colors.danger }]}>Clear</ThemedText>
          </Pressable>
        </View>
        {auditLoading ? (
          <View style={styles.center}>
            <ActivityIndicator />
          </View>
        ) : auditEntries.length === 0 ? (
          <View style={styles.center}>
            <ThemedText style={{ color: colors.muted }}>No entries yet.</ThemedText>
          </View>
        ) : (
          <FlatList
            data={auditEntries}
            keyExtractor={(e) => e.id}
            contentContainerStyle={{ padding: Spacing.lg, gap: Spacing.sm, paddingBottom: Spacing.xxl }}
            renderItem={({ item }) => (
              <View style={[styles.auditEntry, { backgroundColor: colors.surface }]}>
                <ThemedText style={[Type.meta, { color: colors.muted }]}>
                  {new Date(item.at).toLocaleString()} · {item.strategy}
                </ThemedText>
                <ThemedText style={[Type.label, { color: colors.text }]} numberOfLines={1}>
                  Kept: {basename(item.keptKey)}
                </ThemedText>
                <ThemedText style={[Type.meta, { color: colors.muted }]}>
                  Deleted {item.discardedKeys.length} file(s) · saved {formatBytes(item.recoveredBytes)}
                </ThemedText>
              </View>
            )}
          />
        )}
      </ThemedView>
    );
  }

  return (
    <ThemedView style={styles.container}>
      {/* Versioning advisory banner — always shown */}
      <View style={[styles.banner, { backgroundColor: colors.accentSoft }]}>
        <Ionicons name="shield-checkmark-outline" size={16} color={colors.tint} />
        <ThemedText style={[Type.meta, { color: colors.tint, flex: 1 }]}>
          Enable S3 versioning before deleting — it lets you restore files if you change your mind.
        </ThemedText>
      </View>

      {scanState === 'idle' && (
        <View style={styles.center}>
          <Pressable
            onPress={startScan}
            style={({ pressed }) => [
              styles.scanButton,
              { backgroundColor: colors.tint, opacity: pressed ? 0.8 : 1 },
            ]}>
            <Ionicons name="search" size={20} color={colors.onAccent} />
            <ThemedText style={[Type.bodyStrong, { color: colors.onAccent }]}>Scan bucket</ThemedText>
          </Pressable>
          <Pressable onPress={openAuditLog} style={styles.auditLink}>
            <ThemedText style={[Type.label, { color: colors.muted }]}>View audit log</ThemedText>
          </Pressable>
        </View>
      )}

      {scanState === 'scanning' && (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={colors.tint} />
          <ThemedText style={[Type.body, { color: colors.text, marginTop: Spacing.md }]}>
            Scanning…
          </ThemedText>
          <ThemedText style={[Type.meta, { color: colors.muted, marginTop: Spacing.xs }]}>
            {progress.filesScanned} files scanned · page {progress.pagesFetched}
          </ThemedText>
          <Pressable onPress={cancelScan} style={styles.auditLink}>
            <ThemedText style={[Type.label, { color: colors.danger }]}>Cancel</ThemedText>
          </Pressable>
        </View>
      )}

      {scanState === 'error' && (
        <View style={styles.center}>
          <ThemedText style={{ color: colors.danger }}>{scanError}</ThemedText>
          <Pressable
            onPress={startScan}
            style={({ pressed }) => [styles.retryButton, { borderColor: colors.tint, opacity: pressed ? 0.7 : 1 }]}>
            <ThemedText style={{ color: colors.tint, fontWeight: '600' }}>Retry</ThemedText>
          </Pressable>
        </View>
      )}

      {scanState === 'done' && (
        <>
          {/* Summary header */}
          <View style={[styles.summaryBar, { backgroundColor: colors.surfaceMuted }]}>
            <View style={{ flex: 1 }}>
              {pendingGroups.length === 0 ? (
                <ThemedText style={[Type.bodyStrong, { color: colors.text }]}>No duplicates found</ThemedText>
              ) : (
                <>
                  <ThemedText style={[Type.bodyStrong, { color: colors.text }]}>
                    {pendingGroups.length} group(s) · {totalDupeFiles} duplicate(s)
                  </ThemedText>
                  <ThemedText style={[Type.meta, { color: colors.muted }]}>
                    Recoverable: {formatBytes(totalRecoverableBytes)}
                  </ThemedText>
                </>
              )}
              {progress.filesSkippedMultipart > 0 && (
                <ThemedText style={[Type.meta, { color: colors.muted }]}>
                  {progress.filesSkippedMultipart} multipart file(s) skipped
                </ThemedText>
              )}
            </View>
            <Pressable
              onPress={startScan}
              hitSlop={8}
              style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })}>
              <Ionicons name="refresh" size={20} color={colors.tint} />
            </Pressable>
          </View>

          {pendingGroups.length > 0 && (
            <FlatList
              data={pendingGroups}
              keyExtractor={(g) => g.id}
              contentContainerStyle={{ padding: Spacing.lg, gap: Spacing.md, paddingBottom: Spacing.xxl }}
              renderItem={renderGroupCard}
              ListHeaderComponent={
                <Pressable
                  onPress={confirmBatchApply}
                  disabled={applying}
                  style={({ pressed }) => [
                    styles.batchButton,
                    { backgroundColor: colors.danger, opacity: applying || pressed ? 0.7 : 1 },
                  ]}>
                  <ThemedText style={[Type.bodyStrong, { color: colors.onAccent }]}>
                    Apply "keep newest" to all remaining
                  </ThemedText>
                </Pressable>
              }
              ListFooterComponent={
                <View style={{ marginTop: Spacing.lg, alignItems: 'center' }}>
                  <Pressable onPress={openAuditLog}>
                    <ThemedText style={[Type.label, { color: colors.muted }]}>View audit log</ThemedText>
                  </Pressable>
                </View>
              }
            />
          )}

          {pendingGroups.length === 0 && (
            <View style={styles.center}>
              <Ionicons name="checkmark-circle-outline" size={48} color={colors.tint} />
              <ThemedText style={[Type.body, { color: colors.muted, marginTop: Spacing.sm }]}>
                {groups.length === 0 ? 'No duplicates found in this bucket.' : 'All duplicates resolved.'}
              </ThemedText>
              <Pressable onPress={openAuditLog} style={styles.auditLink}>
                <ThemedText style={[Type.label, { color: colors.muted }]}>View audit log</ThemedText>
              </Pressable>
            </View>
          )}
        </>
      )}

      {applying && (
        <View style={styles.busyOverlay}>
          <ThemedView style={styles.busyCard}>
            <ActivityIndicator />
            <ThemedText>Deleting duplicates…</ThemedText>
          </ThemedView>
        </View>
      )}
    </ThemedView>
  );
}

const THUMB_SIZE = 56;

const styles = StyleSheet.create({
  container: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: Spacing.md, padding: Spacing.xl },
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.sm,
  },
  scanButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    paddingHorizontal: Spacing.xl,
    paddingVertical: Spacing.md,
    borderRadius: Radius.pill,
  },
  auditLink: { paddingVertical: Spacing.sm },
  retryButton: {
    paddingHorizontal: Spacing.xl,
    paddingVertical: Spacing.sm,
    borderRadius: Radius.md,
    borderWidth: 1,
  },
  summaryBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.md,
    gap: Spacing.md,
  },
  batchButton: {
    paddingVertical: Spacing.md,
    borderRadius: Radius.md,
    alignItems: 'center',
    marginBottom: Spacing.md,
  },
  card: {
    padding: Spacing.md,
    borderRadius: Radius.lg,
    gap: Spacing.xs,
  },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
  },
  fileRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    paddingVertical: 2,
  },
  thumbStrip: {
    flexDirection: 'row',
    gap: Spacing.xs,
  },
  thumbSlot: {
    width: THUMB_SIZE,
    height: THUMB_SIZE,
    borderRadius: Radius.sm,
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
  },
  thumbImg: {
    width: THUMB_SIZE,
    height: THUMB_SIZE,
  },
  actionRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: Spacing.xs,
    marginTop: Spacing.xs,
  },
  actionChip: {
    paddingHorizontal: Spacing.sm,
    paddingVertical: Spacing.xs,
    borderRadius: Radius.pill,
  },
  applyButton: {
    marginTop: Spacing.sm,
    paddingVertical: Spacing.sm,
    borderRadius: Radius.md,
    alignItems: 'center',
  },
  busyOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(0,0,0,0.4)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  busyCard: {
    padding: Spacing.xl,
    borderRadius: Radius.lg,
    gap: Spacing.md,
    alignItems: 'center',
    minWidth: 200,
  },
  auditHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.md,
  },
  auditEntry: {
    padding: Spacing.md,
    borderRadius: Radius.md,
    gap: 2,
  },
});
