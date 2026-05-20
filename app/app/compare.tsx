import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { useLocalSearchParams, useNavigation } from 'expo-router';
import { useLayoutEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
} from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { useAlert } from '@/components/ui/alert-provider';
import { Colors, Radius, Shadow, Spacing, Type } from '@/constants/theme';
import { useColorScheme } from '@/hooks/use-color-scheme';
import { api, type GetDerivedUrlResponse } from '@/lib/api';
import { appendAudit } from '@/lib/audit';
import { diffFolders, scanFolder, type ComparePair, type FolderCompareResult, type UncomparableFile } from '@/lib/compare';
import { type ScanProgress, type ScannedFile } from '@/lib/duplicates';
import { basename, formatBytes } from '@/lib/format';

type ScanState = 'idle' | 'scanning' | 'done' | 'error';
type ActiveSection = 'shared' | 'only-a' | 'only-b' | 'uncomparable' | null;

type PairDecision = { kind: 'keep-a' } | { kind: 'keep-b' } | { kind: 'skip' };
type SingleDecision = { kind: 'delete' } | { kind: 'skip' };

export default function CompareScreen() {
  const colorScheme = useColorScheme() ?? 'light';
  const colors = Colors[colorScheme];
  const { showAlert } = useAlert();
  const navigation = useNavigation();

  // Router params: a and b are folder prefixes, pre-sorted lexicographically.
  const { a: rawA, b: rawB } = useLocalSearchParams<{ a: string; b: string }>();
  const prefixA = rawA ?? '';
  const prefixB = rawB ?? '';
  const nameA = basename(prefixA.replace(/\/$/, '')) || prefixA;
  const nameB = basename(prefixB.replace(/\/$/, '')) || prefixB;

  useLayoutEffect(() => {
    navigation.setOptions({
      title: nameA && nameB ? `${nameA} vs ${nameB}` : 'Compare folders',
    });
  }, [navigation, nameA, nameB]);

  const [scanState, setScanState] = useState<ScanState>('idle');
  const [scanError, setScanError] = useState<string | null>(null);
  const [progressA, setProgressA] = useState<ScanProgress>({
    pagesFetched: 0,
    filesScanned: 0,
    filesWithEtag: 0,
    filesSkippedMultipart: 0,
  });
  const [progressB, setProgressB] = useState<ScanProgress>({
    pagesFetched: 0,
    filesScanned: 0,
    filesWithEtag: 0,
    filesSkippedMultipart: 0,
  });
  const [result, setResult] = useState<FolderCompareResult | null>(null);
  const [activeSection, setActiveSection] = useState<ActiveSection>(null);

  const [pairDecisions, setPairDecisions] = useState<Map<string, PairDecision>>(new Map());
  const [onlyADecisions, setOnlyADecisions] = useState<Map<string, SingleDecision>>(new Map());
  const [onlyBDecisions, setOnlyBDecisions] = useState<Map<string, SingleDecision>>(new Map());

  const [thumbCache, setThumbCache] = useState<Map<string, string>>(new Map());
  const [applying, setApplying] = useState(false);

  const abortRef = useRef<AbortController | null>(null);

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

  async function startScan() {
    const controller = new AbortController();
    abortRef.current = controller;

    setScanState('scanning');
    setScanError(null);
    setResult(null);
    setActiveSection(null);
    setPairDecisions(new Map());
    setOnlyADecisions(new Map());
    setOnlyBDecisions(new Map());
    setThumbCache(new Map());

    const initProg: ScanProgress = { pagesFetched: 0, filesScanned: 0, filesWithEtag: 0, filesSkippedMultipart: 0 };
    setProgressA({ ...initProg });
    setProgressB({ ...initProg });

    try {
      const [scanA, scanB] = await Promise.all([
        scanFolder(prefixA, controller.signal, (p) => setProgressA({ ...p })),
        scanFolder(prefixB, controller.signal, (p) => setProgressB({ ...p })),
      ]);

      if (controller.signal.aborted) {
        setScanState('idle');
        return;
      }

      const diff = diffFolders(prefixA, prefixB, scanA, scanB);
      setResult(diff);
      setScanState('done');
    } catch (err) {
      if (controller.signal.aborted) {
        setScanState('idle');
        return;
      }
      setScanError(err instanceof Error ? err.message : 'Unknown error');
      setScanState('error');
    }
  }

  function cancelScan() {
    abortRef.current?.abort();
  }

  // ---- Decision helpers ----

  function setPairDecision(etag: string, d: PairDecision) {
    setPairDecisions((prev) => {
      const next = new Map(prev);
      next.set(etag, d);
      return next;
    });
  }

  function setOnlyADecision(key: string, d: SingleDecision) {
    setOnlyADecisions((prev) => {
      const next = new Map(prev);
      next.set(key, d);
      return next;
    });
  }

  function setOnlyBDecision(key: string, d: SingleDecision) {
    setOnlyBDecisions((prev) => {
      const next = new Map(prev);
      next.set(key, d);
      return next;
    });
  }

  // ---- Apply: shared pairs ----

  async function runApplyShared() {
    if (!result) return;
    const toDelete: Array<{ etag: string; keep: string; discard: string; size: number }> = [];
    for (const pair of result.shared) {
      const d = pairDecisions.get(pair.etag);
      if (!d || d.kind === 'skip') continue;
      if (d.kind === 'keep-a') {
        toDelete.push({ etag: pair.etag, keep: pair.a.key, discard: pair.b.key, size: pair.size });
      } else {
        toDelete.push({ etag: pair.etag, keep: pair.b.key, discard: pair.a.key, size: pair.size });
      }
    }

    if (toDelete.length === 0) {
      showAlert('No decisions made', 'Choose Keep A or Keep B for at least one pair.');
      return;
    }

    const totalBytes = toDelete.reduce((acc, x) => acc + x.size, 0);
    showAlert(
      `Delete ${toDelete.length} file(s)?`,
      `Frees ~${formatBytes(totalBytes)}. S3 versioning recommended.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () => runApplySharedConfirmed(toDelete),
        },
      ],
    );
  }

  async function runApplySharedConfirmed(
    toDelete: Array<{ etag: string; keep: string; discard: string; size: number }>,
  ) {
    setApplying(true);
    try {
      const keys = toDelete.map((x) => x.discard);
      const res = await api.delete({ keys });

      if (res.errors.length > 0) {
        const errList = res.errors
          .slice(0, 5)
          .map((e) => `• ${basename(e.key)}: ${e.message}`)
          .join('\n');
        showAlert(
          'Partial delete',
          `Deleted ${res.deleted.length} of ${keys.length}.\n${res.errors.length} failed:\n${errList}`,
        );
      }

      const deletedSet = new Set(res.deleted);
      // Write one audit entry per successfully deleted pair.
      for (const x of toDelete) {
        if (!deletedSet.has(x.discard)) continue;
        await appendAudit({
          action: 'delete-folder-compare',
          strategy: 'manual',
          keptKey: x.keep,
          discardedKeys: [x.discard],
          recoveredBytes: x.size,
        });
      }

      if (res.deleted.length > 0) {
        // Build the set of etags whose discard key was successfully deleted.
        const resolvedEtags = new Set(
          toDelete.filter((x) => deletedSet.has(x.discard)).map((x) => x.etag),
        );

        setResult((prev) =>
          prev
            ? { ...prev, shared: prev.shared.filter((p) => !resolvedEtags.has(p.etag)) }
            : prev,
        );
        setPairDecisions((prev) => {
          const next = new Map(prev);
          for (const etag of resolvedEtags) next.delete(etag);
          return next;
        });
      }
    } catch (err) {
      showAlert('Delete failed', err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setApplying(false);
    }
  }

  // ---- Apply: only-A section ----

  async function runApplyOnlyA() {
    if (!result) return;
    const toDelete = result.onlyInA.filter((f) => {
      const d = onlyADecisions.get(f.key);
      return d?.kind === 'delete';
    });

    if (toDelete.length === 0) {
      showAlert('No deletions selected', 'Mark at least one file as Delete in the "Only in A" section.');
      return;
    }

    const totalBytes = toDelete.reduce((acc, f) => acc + f.size, 0);
    showAlert(
      `Delete ${toDelete.length} file(s) from "${nameA}"?`,
      `Frees ~${formatBytes(totalBytes)}. S3 versioning recommended.`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Delete', style: 'destructive', onPress: () => runApplySingleSection(toDelete, 'a') },
      ],
    );
  }

  async function runApplyOnlyB() {
    if (!result) return;
    const toDelete = result.onlyInB.filter((f) => {
      const d = onlyBDecisions.get(f.key);
      return d?.kind === 'delete';
    });

    if (toDelete.length === 0) {
      showAlert('No deletions selected', 'Mark at least one file as Delete in the "Only in B" section.');
      return;
    }

    const totalBytes = toDelete.reduce((acc, f) => acc + f.size, 0);
    showAlert(
      `Delete ${toDelete.length} file(s) from "${nameB}"?`,
      `Frees ~${formatBytes(totalBytes)}. S3 versioning recommended.`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Delete', style: 'destructive', onPress: () => runApplySingleSection(toDelete, 'b') },
      ],
    );
  }

  async function runApplySingleSection(files: ScannedFile[], side: 'a' | 'b') {
    setApplying(true);
    try {
      const keys = files.map((f) => f.key);
      const res = await api.delete({ keys });

      if (res.errors.length > 0) {
        const errList = res.errors
          .slice(0, 5)
          .map((e) => `• ${basename(e.key)}: ${e.message}`)
          .join('\n');
        showAlert(
          'Partial delete',
          `Deleted ${res.deleted.length} of ${keys.length}.\n${res.errors.length} failed:\n${errList}`,
        );
      }

      if (res.deleted.length > 0) {
        const deletedSetForBytes = new Set(res.deleted);
        // Only count bytes for keys that were actually deleted — avoids
        // over-reporting when the API returns partial failures.
        const recoveredBytes = files
          .filter((f) => deletedSetForBytes.has(f.key))
          .reduce((acc, f) => acc + f.size, 0);

        // Bulk audit entry for the section.
        await appendAudit({
          action: 'delete-folder-compare',
          strategy: 'manual',
          keptKey: side === 'a' ? prefixB : prefixA,
          discardedKeys: res.deleted,
          recoveredBytes,
        });

        if (side === 'a') {
          setResult((prev) =>
            prev ? { ...prev, onlyInA: prev.onlyInA.filter((f) => !deletedSetForBytes.has(f.key)) } : prev,
          );
          setOnlyADecisions((prev) => {
            const next = new Map(prev);
            for (const k of deletedSetForBytes) next.delete(k);
            return next;
          });
        } else {
          setResult((prev) =>
            prev ? { ...prev, onlyInB: prev.onlyInB.filter((f) => !deletedSetForBytes.has(f.key)) } : prev,
          );
          setOnlyBDecisions((prev) => {
            const next = new Map(prev);
            for (const k of deletedSetForBytes) next.delete(k);
            return next;
          });
        }
      }
    } catch (err) {
      showAlert('Delete failed', err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setApplying(false);
    }
  }

  // ---- Render helpers ----

  function renderThumb(key: string, kind: 'image' | 'video' | 'other') {
    const thumbUrl = thumbCache.get(key);
    if (!thumbUrl && kind !== 'other') ensureThumb(key, kind);
    return (
      <View style={[styles.thumbSlot, { backgroundColor: colors.surfaceMuted }]}>
        {thumbUrl ? (
          <Image source={{ uri: thumbUrl }} style={styles.thumbImg} contentFit="cover" recyclingKey={key} />
        ) : (
          <Ionicons
            name={kind === 'video' ? 'videocam-outline' : 'image-outline'}
            size={20}
            color={colors.muted}
          />
        )}
      </View>
    );
  }

  function renderSummary() {
    if (!result) return null;
    const { onlyInA, onlyInB, shared, uncomparable, totals } = result;
    const uncomparableCount = uncomparable.a.length + uncomparable.b.length;

    const sections: Array<{
      id: ActiveSection;
      label: string;
      count: number;
      bytes: number;
      color: string;
    }> = [
      {
        id: 'shared',
        label: 'Shared (same content)',
        count: shared.length,
        bytes: totals.sharedBytesBothSides,
        color: colors.tint,
      },
      {
        id: 'only-a',
        label: `Only in ${nameA}`,
        count: onlyInA.length,
        bytes: onlyInA.reduce((acc, f) => acc + f.size, 0),
        color: colors.text,
      },
      {
        id: 'only-b',
        label: `Only in ${nameB}`,
        count: onlyInB.length,
        bytes: onlyInB.reduce((acc, f) => acc + f.size, 0),
        color: colors.text,
      },
      {
        id: 'uncomparable',
        label: 'Could not compare',
        count: uncomparableCount,
        bytes: totals.uncomparableBytes,
        color: colors.muted,
      },
    ];

    return (
      <View style={{ gap: Spacing.xs }}>
        {sections.map((s) => (
          <Pressable
            key={s.id}
            onPress={() => setActiveSection(activeSection === s.id ? null : s.id)}
            style={({ pressed }) => [
              styles.summaryRow,
              {
                backgroundColor: activeSection === s.id ? colors.accentSoft : colors.surface,
                opacity: pressed ? 0.8 : 1,
              },
              Shadow.card,
            ]}>
            <View style={{ flex: 1 }}>
              <ThemedText style={[Type.label, { color: s.color }]}>{s.label}</ThemedText>
              <ThemedText style={[Type.meta, { color: colors.muted }]}>
                {s.count} file(s) · {formatBytes(s.bytes)}
              </ThemedText>
            </View>
            <Ionicons
              name={activeSection === s.id ? 'chevron-up' : 'chevron-down'}
              size={16}
              color={colors.muted}
            />
          </Pressable>
        ))}
      </View>
    );
  }

  function renderSharedSection() {
    if (!result || result.shared.length === 0) {
      return (
        <View style={styles.emptySection}>
          <ThemedText style={[Type.meta, { color: colors.muted }]}>No shared files found.</ThemedText>
        </View>
      );
    }

    const actionable = result.shared.filter((p) => {
      const d = pairDecisions.get(p.etag);
      return d && d.kind !== 'skip';
    });

    return (
      <>
        {actionable.length > 0 && (
          <Pressable
            onPress={runApplyShared}
            disabled={applying}
            style={({ pressed }) => [
              styles.applyButton,
              { backgroundColor: colors.danger, opacity: applying || pressed ? 0.7 : 1 },
            ]}>
            <ThemedText style={[Type.label, { color: colors.onAccent, fontWeight: '600' }]}>
              Apply {actionable.length} decision(s) — delete chosen files
            </ThemedText>
          </Pressable>
        )}
        {result.shared.map((pair) => renderPairCard(pair))}
      </>
    );
  }

  function renderPairCard(pair: ComparePair) {
    const decision = pairDecisions.get(pair.etag);
    return (
      <View key={pair.etag} style={[styles.card, { backgroundColor: colors.surface }, Shadow.card]}>
        <View style={styles.cardHeader}>
          <ThemedText style={[Type.meta, { color: colors.muted }]}>
            Same content · {formatBytes(pair.size)}
          </ThemedText>
        </View>

        <View style={styles.sideRow}>
          <View style={[styles.sideLabel, { backgroundColor: colors.accentSoft }]}>
            <ThemedText style={[Type.meta, { color: colors.tint, fontWeight: '600' }]}>A</ThemedText>
          </View>
          {renderThumb(pair.a.key, pair.a.kind)}
          <ThemedText style={[Type.meta, { color: colors.text, flex: 1 }]} numberOfLines={2}>
            {pair.a.key}
          </ThemedText>
        </View>

        <View style={styles.sideRow}>
          <View style={[styles.sideLabel, { backgroundColor: colors.surfaceMuted }]}>
            <ThemedText style={[Type.meta, { color: colors.muted, fontWeight: '600' }]}>B</ThemedText>
          </View>
          {renderThumb(pair.b.key, pair.b.kind)}
          <ThemedText style={[Type.meta, { color: colors.text, flex: 1 }]} numberOfLines={2}>
            {pair.b.key}
          </ThemedText>
        </View>

        <View style={styles.actionRow}>
          {(
            [
              { kind: 'keep-a' as const, label: `Keep A (delete B)` },
              { kind: 'keep-b' as const, label: `Keep B (delete A)` },
              { kind: 'skip' as const, label: 'Skip' },
            ] as const
          ).map(({ kind, label }) => {
            const active = decision?.kind === kind;
            return (
              <Pressable
                key={kind}
                onPress={() => setPairDecision(pair.etag, { kind })}
                style={({ pressed }) => [
                  styles.actionChip,
                  {
                    backgroundColor: active
                      ? kind === 'skip'
                        ? colors.accentSoft
                        : colors.tint
                      : colors.surfaceMuted,
                    opacity: pressed ? 0.7 : 1,
                  },
                ]}>
                <ThemedText
                  style={[
                    Type.meta,
                    {
                      color: active && kind !== 'skip' ? colors.onAccent : kind === 'skip' ? colors.tint : colors.text,
                    },
                  ]}>
                  {label}
                </ThemedText>
              </Pressable>
            );
          })}
        </View>
      </View>
    );
  }

  function renderSingleSection(
    files: ScannedFile[],
    decisions: Map<string, SingleDecision>,
    setDecision: (key: string, d: SingleDecision) => void,
    emptyMsg: string,
    onApply: () => void,
  ) {
    if (files.length === 0) {
      return (
        <View style={styles.emptySection}>
          <ThemedText style={[Type.meta, { color: colors.muted }]}>{emptyMsg}</ThemedText>
        </View>
      );
    }

    const toDeleteCount = files.filter((f) => decisions.get(f.key)?.kind === 'delete').length;

    return (
      <>
        {toDeleteCount > 0 && (
          <Pressable
            onPress={onApply}
            disabled={applying}
            style={({ pressed }) => [
              styles.applyButton,
              { backgroundColor: colors.danger, opacity: applying || pressed ? 0.7 : 1 },
            ]}>
            <ThemedText style={[Type.label, { color: colors.onAccent, fontWeight: '600' }]}>
              Delete {toDeleteCount} selected file(s)
            </ThemedText>
          </Pressable>
        )}
        {files.map((f) => {
          const d = decisions.get(f.key);
          return (
            <View key={f.key} style={[styles.card, { backgroundColor: colors.surface }, Shadow.card]}>
              <View style={styles.sideRow}>
                {renderThumb(f.key, f.kind)}
                <ThemedText style={[Type.meta, { color: colors.text, flex: 1 }]} numberOfLines={2}>
                  {f.key}
                </ThemedText>
                <ThemedText style={[Type.meta, { color: colors.muted }]}>
                  {formatBytes(f.size)}
                </ThemedText>
              </View>
              <View style={styles.actionRow}>
                <Pressable
                  onPress={() => setDecision(f.key, { kind: 'delete' })}
                  style={({ pressed }) => [
                    styles.actionChip,
                    {
                      backgroundColor: d?.kind === 'delete' ? colors.danger : colors.surfaceMuted,
                      opacity: pressed ? 0.7 : 1,
                    },
                  ]}>
                  <ThemedText
                    style={[Type.meta, { color: d?.kind === 'delete' ? colors.onAccent : colors.text }]}>
                    Delete
                  </ThemedText>
                </Pressable>
                <Pressable
                  onPress={() => setDecision(f.key, { kind: 'skip' })}
                  style={({ pressed }) => [
                    styles.actionChip,
                    {
                      backgroundColor: d?.kind === 'skip' ? colors.accentSoft : colors.surfaceMuted,
                      opacity: pressed ? 0.7 : 1,
                    },
                  ]}>
                  <ThemedText style={[Type.meta, { color: colors.tint }]}>Skip</ThemedText>
                </Pressable>
              </View>
            </View>
          );
        })}
      </>
    );
  }

  function renderUncomparableSection() {
    if (!result) return null;
    const all = [...result.uncomparable.a, ...result.uncomparable.b];
    if (all.length === 0) {
      return (
        <View style={styles.emptySection}>
          <ThemedText style={[Type.meta, { color: colors.muted }]}>
            All files had comparable ETags.
          </ThemedText>
        </View>
      );
    }
    return (
      <>
        <ThemedText style={[Type.meta, { color: colors.muted, marginBottom: Spacing.xs }]}>
          These files were skipped because their ETag is missing or is a multipart ETag
          (e.g. uploaded in multiple parts), which cannot be compared reliably across clients.
          They are shown for reference only.
        </ThemedText>
        {all.map((f) => (
          <View key={f.key} style={[styles.card, { backgroundColor: colors.surface }, Shadow.card]}>
            <View style={styles.sideRow}>
              <Ionicons name="alert-circle-outline" size={20} color={colors.muted} />
              <ThemedText style={[Type.meta, { color: colors.text, flex: 1 }]} numberOfLines={2}>
                {f.key}
              </ThemedText>
              <ThemedText style={[Type.meta, { color: colors.muted }]}>
                {formatBytes(f.size)}
              </ThemedText>
            </View>
            <ThemedText style={[Type.meta, { color: colors.muted }]}>
              Reason:{' '}
              {f.reason === 'no-etag'
                ? 'No ETag returned by server'
                : f.reason === 'multipart'
                  ? 'Multipart ETag'
                  : 'Duplicate within folder'}
            </ThemedText>
          </View>
        ))}
      </>
    );
  }

  function renderActiveSection() {
    if (!result || !activeSection) return null;
    return (
      <View style={{ gap: Spacing.sm, marginTop: Spacing.sm }}>
        {activeSection === 'shared' && renderSharedSection()}
        {activeSection === 'only-a' &&
          renderSingleSection(
            result.onlyInA,
            onlyADecisions,
            setOnlyADecision,
            `No files found only in "${nameA}".`,
            runApplyOnlyA,
          )}
        {activeSection === 'only-b' &&
          renderSingleSection(
            result.onlyInB,
            onlyBDecisions,
            setOnlyBDecision,
            `No files found only in "${nameB}".`,
            runApplyOnlyB,
          )}
        {activeSection === 'uncomparable' && renderUncomparableSection()}
      </View>
    );
  }

  // ---- Main render ----

  return (
    <ThemedView style={styles.container}>
      {/* S3 versioning advisory banner */}
      <View style={[styles.banner, { backgroundColor: colors.accentSoft }]}>
        <Ionicons name="shield-checkmark-outline" size={16} color={colors.tint} />
        <ThemedText style={[Type.meta, { color: colors.tint, flex: 1 }]}>
          Enable S3 versioning before deleting — it lets you restore files if you change your mind.
        </ThemedText>
      </View>

      {/* Folder label bar */}
      <View style={[styles.folderBar, { backgroundColor: colors.surfaceMuted }]}>
        <View style={styles.folderChip}>
          <View style={[styles.sideLabel, { backgroundColor: colors.accentSoft }]}>
            <ThemedText style={[Type.meta, { color: colors.tint, fontWeight: '600' }]}>A</ThemedText>
          </View>
          <ThemedText style={[Type.meta, { color: colors.text }]} numberOfLines={1}>{nameA}</ThemedText>
        </View>
        <ThemedText style={[Type.meta, { color: colors.muted }]}>vs</ThemedText>
        <View style={styles.folderChip}>
          <View style={[styles.sideLabel, { backgroundColor: colors.surfaceMuted }]}>
            <ThemedText style={[Type.meta, { color: colors.muted, fontWeight: '600' }]}>B</ThemedText>
          </View>
          <ThemedText style={[Type.meta, { color: colors.text }]} numberOfLines={1}>{nameB}</ThemedText>
        </View>
      </View>

      {scanState === 'idle' && (
        <View style={styles.center}>
          <Pressable
            onPress={startScan}
            style={({ pressed }) => [
              styles.scanButton,
              { backgroundColor: colors.tint, opacity: pressed ? 0.8 : 1 },
            ]}>
            <Ionicons name="git-compare-outline" size={20} color={colors.onAccent} />
            <ThemedText style={[Type.bodyStrong, { color: colors.onAccent }]}>Compare folders</ThemedText>
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
            A: {progressA.filesScanned} files · B: {progressB.filesScanned} files
          </ThemedText>
          <Pressable onPress={cancelScan} style={styles.cancelLink}>
            <ThemedText style={[Type.label, { color: colors.danger }]}>Cancel</ThemedText>
          </Pressable>
        </View>
      )}

      {scanState === 'error' && (
        <View style={styles.center}>
          <ThemedText style={{ color: colors.danger }}>{scanError}</ThemedText>
          <Pressable
            onPress={startScan}
            style={({ pressed }) => [
              styles.retryButton,
              { borderColor: colors.tint, opacity: pressed ? 0.7 : 1 },
            ]}>
            <ThemedText style={{ color: colors.tint, fontWeight: '600' }}>Retry</ThemedText>
          </Pressable>
        </View>
      )}

      {scanState === 'done' && result && (
        <ScrollView contentContainerStyle={styles.scrollContent}>
          {renderSummary()}
          {renderActiveSection()}
        </ScrollView>
      )}

      {applying && (
        <View style={styles.busyOverlay}>
          <ThemedView style={styles.busyCard}>
            <ActivityIndicator />
            <ThemedText>Deleting…</ThemedText>
          </ThemedView>
        </View>
      )}
    </ThemedView>
  );
}

const THUMB_SIZE = 48;

const styles = StyleSheet.create({
  container: { flex: 1 },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.md,
    padding: Spacing.xl,
  },
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.sm,
  },
  folderBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.sm,
  },
  folderChip: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.xs,
  },
  scanButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    paddingHorizontal: Spacing.xl,
    paddingVertical: Spacing.md,
    borderRadius: Radius.pill,
  },
  cancelLink: { paddingVertical: Spacing.sm },
  retryButton: {
    paddingHorizontal: Spacing.xl,
    paddingVertical: Spacing.sm,
    borderRadius: Radius.md,
    borderWidth: 1,
  },
  scrollContent: {
    padding: Spacing.lg,
    gap: Spacing.sm,
    paddingBottom: Spacing.xxl,
  },
  summaryRow: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: Spacing.md,
    borderRadius: Radius.md,
    gap: Spacing.sm,
  },
  emptySection: {
    alignItems: 'center',
    paddingVertical: Spacing.xl,
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
  sideRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
  },
  sideLabel: {
    width: 22,
    height: 22,
    borderRadius: Radius.sm,
    alignItems: 'center',
    justifyContent: 'center',
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
    paddingVertical: Spacing.md,
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
});
