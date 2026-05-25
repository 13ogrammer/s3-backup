import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { useLocalSearchParams, useNavigation } from 'expo-router';
import React, { Dispatch, SetStateAction, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
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
import { useJobs } from '@/lib/jobs';

type ScanState = 'idle' | 'scanning' | 'done' | 'error';
type ActiveSection = 'shared' | 'only-a' | 'only-b' | 'uncomparable' | null;

type PairDecision = { kind: 'keep-a' } | { kind: 'keep-b' } | { kind: 'skip' };
type SingleDecision = { kind: 'delete' } | { kind: 'move-to-other' } | { kind: 'skip' };

// ---- Row union type for FlatList ----

type CompareRow =
  | { type: 'pair'; key: string; pair: ComparePair }
  | { type: 'single-a'; key: string; file: ScannedFile }
  | { type: 'single-b'; key: string; file: ScannedFile }
  | { type: 'uncomparable'; key: string; file: UncomparableFile };

// ---- Module-scope memoised card components ----

const THUMB_SIZE = 48;

type RenderThumbFn = (key: string, kind: 'image' | 'video' | 'other', previewUrl?: string) => React.ReactNode;

type PairCardProps = {
  pair: ComparePair;
  decision: PairDecision | undefined;
  applying: boolean;
  colors: typeof Colors.light;
  renderThumb: RenderThumbFn;
  onSetDecision: (etag: string, d: PairDecision) => void;
  onClearDecision: (etag: string) => void;
};

const PairCard = React.memo(function PairCard({
  pair,
  decision,
  applying,
  colors,
  renderThumb,
  onSetDecision,
  onClearDecision,
}: PairCardProps) {
  return (
    <View
      style={[
        cmpStyles.card,
        {
          backgroundColor:
            decision?.kind === 'keep-a' || decision?.kind === 'keep-b'
              ? colors.accentSoft
              : decision?.kind === 'skip'
                ? colors.surfaceMuted
                : colors.surface,
        },
        Shadow.card,
      ]}>
      <View style={cmpStyles.cardHeader}>
        <ThemedText style={[Type.meta, { color: colors.muted }]}>
          Same content · {formatBytes(pair.size)}
        </ThemedText>
      </View>

      <View style={cmpStyles.sideRow}>
        <View style={[cmpStyles.sideLabel, { backgroundColor: colors.accentSoft }]}>
          <ThemedText style={[Type.meta, { color: colors.tint, fontWeight: '600' }]}>A</ThemedText>
        </View>
        {renderThumb(pair.a.key, pair.a.kind, pair.a.previewUrl)}
        <ThemedText style={[Type.meta, { color: colors.text, flex: 1 }]} numberOfLines={2}>
          {pair.a.key}
        </ThemedText>
      </View>

      <View style={cmpStyles.sideRow}>
        <View style={[cmpStyles.sideLabel, { backgroundColor: colors.surfaceMuted }]}>
          <ThemedText style={[Type.meta, { color: colors.muted, fontWeight: '600' }]}>B</ThemedText>
        </View>
        {renderThumb(pair.b.key, pair.b.kind, pair.b.previewUrl)}
        <ThemedText style={[Type.meta, { color: colors.text, flex: 1 }]} numberOfLines={2}>
          {pair.b.key}
        </ThemedText>
      </View>

      <View style={cmpStyles.actionRow}>
        {(
          [
            { kind: 'keep-a' as const, label: 'Keep A (delete B)' },
            { kind: 'keep-b' as const, label: 'Keep B (delete A)' },
            { kind: 'skip' as const, label: 'Skip' },
          ] as const
        ).map(({ kind, label }) => {
          const active = decision?.kind === kind;
          return (
            <Pressable
              key={kind}
              disabled={applying}
              onPress={() =>
                decision?.kind === kind
                  ? onClearDecision(pair.etag)
                  : onSetDecision(pair.etag, { kind })
              }
              style={({ pressed }) => [
                cmpStyles.actionChip,
                {
                  backgroundColor: active
                    ? kind === 'skip'
                      ? colors.accentSoft
                      : colors.tint
                    : colors.surfaceMuted,
                  opacity: applying || pressed ? 0.7 : 1,
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
});

type SingleCardProps = {
  file: ScannedFile;
  decision: SingleDecision | undefined;
  applying: boolean;
  isInFlight: boolean;
  colors: typeof Colors.light;
  otherName: string;
  renderThumb: RenderThumbFn;
  onSetDecision: (key: string, d: SingleDecision) => void;
  onClearDecision: (key: string) => void;
};

const SingleCard = React.memo(function SingleCard({
  file,
  decision,
  applying,
  isInFlight,
  colors,
  otherName,
  renderThumb,
  onSetDecision,
  onClearDecision,
}: SingleCardProps) {
  return (
    <View
      pointerEvents={isInFlight ? 'none' : 'auto'}
      style={[
        cmpStyles.card,
        {
          backgroundColor:
            decision?.kind === 'delete'
              ? colors.dangerSoft
              : decision?.kind === 'move-to-other'
                ? colors.accentSoft
                : decision?.kind === 'skip'
                  ? colors.surfaceMuted
                  : colors.surface,
          opacity: isInFlight ? 0.5 : 1,
        },
        Shadow.card,
      ]}>
      <View style={cmpStyles.sideRow}>
        {renderThumb(file.key, file.kind, file.previewUrl)}
        <ThemedText style={[Type.meta, { color: colors.text, flex: 1 }]} numberOfLines={2}>
          {file.key}
        </ThemedText>
        <ThemedText style={[Type.meta, { color: colors.muted }]}>
          {formatBytes(file.size)}
        </ThemedText>
      </View>
      <View style={cmpStyles.actionRow}>
        <Pressable
          disabled={applying || isInFlight}
          onPress={() =>
            decision?.kind === 'delete'
              ? onClearDecision(file.key)
              : onSetDecision(file.key, { kind: 'delete' })
          }
          style={({ pressed }) => [
            cmpStyles.actionChip,
            {
              backgroundColor: decision?.kind === 'delete' ? colors.danger : colors.surfaceMuted,
              opacity: applying || pressed ? 0.7 : 1,
            },
          ]}>
          <ThemedText
            style={[Type.meta, { color: decision?.kind === 'delete' ? colors.onAccent : colors.text }]}>
            Delete
          </ThemedText>
        </Pressable>
        <Pressable
          disabled={applying || isInFlight}
          onPress={() =>
            decision?.kind === 'move-to-other'
              ? onClearDecision(file.key)
              : onSetDecision(file.key, { kind: 'move-to-other' })
          }
          style={({ pressed }) => [
            cmpStyles.actionChip,
            {
              backgroundColor: decision?.kind === 'move-to-other' ? colors.tint : colors.surfaceMuted,
              opacity: applying || pressed ? 0.7 : 1,
            },
          ]}>
          <ThemedText
            style={[Type.meta, { color: decision?.kind === 'move-to-other' ? colors.onAccent : colors.text }]}>
            Move to {otherName}
          </ThemedText>
        </Pressable>
        <Pressable
          disabled={applying || isInFlight}
          onPress={() =>
            decision?.kind === 'skip'
              ? onClearDecision(file.key)
              : onSetDecision(file.key, { kind: 'skip' })
          }
          style={({ pressed }) => [
            cmpStyles.actionChip,
            {
              backgroundColor: decision?.kind === 'skip' ? colors.accentSoft : colors.surfaceMuted,
              opacity: applying || pressed ? 0.7 : 1,
            },
          ]}>
          <ThemedText style={[Type.meta, { color: colors.tint }]}>Keep</ThemedText>
        </Pressable>
      </View>
    </View>
  );
});

type UncomparableCardProps = {
  file: UncomparableFile;
  colors: typeof Colors.light;
};

const UncomparableCard = React.memo(function UncomparableCard({ file, colors }: UncomparableCardProps) {
  return (
    <View style={[cmpStyles.card, { backgroundColor: colors.surface }, Shadow.card]}>
      <View style={cmpStyles.sideRow}>
        <Ionicons name="alert-circle-outline" size={20} color={colors.muted} />
        <ThemedText style={[Type.meta, { color: colors.text, flex: 1 }]} numberOfLines={2}>
          {file.key}
        </ThemedText>
        <ThemedText style={[Type.meta, { color: colors.muted }]}>
          {formatBytes(file.size)}
        </ThemedText>
      </View>
      <ThemedText style={[Type.meta, { color: colors.muted }]}>
        Reason:{' '}
        {file.reason === 'no-etag'
          ? 'No ETag returned by server'
          : file.reason === 'multipart'
            ? 'Multipart ETag'
            : 'Duplicate within folder'}
      </ThemedText>
    </View>
  );
});

// ---- Screen ----

export default function CompareScreen() {
  const colorScheme = useColorScheme() ?? 'light';
  const colors = Colors[colorScheme];
  const { showAlert } = useAlert();
  const navigation = useNavigation();
  const { addJob, allJobs } = useJobs();

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

  // Auto-start when both folders are available on mount.
  // startScan and scanState intentionally omitted from deps: startScan isn't
  // memoized, and including scanState would re-fire on done→idle transitions.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (prefixA && prefixB && scanState === 'idle') { startScan(); }
  }, [prefixA, prefixB]);

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

  // Keys with an in-flight move job: rows are greyed out but not unmounted.
  const [inFlightMoveKeys, setInFlightMoveKeys] = useState<Set<string>>(new Set());
  // jobId -> { side, keys } for terminal-status cleanup via useEffect.
  const [moveJobIds, setMoveJobIds] = useState<Map<string, { side: 'a' | 'b'; keys: string[] }>>(new Map());

  // Mirror result into a ref so the allJobs effect doesn't re-trigger on every
  // result prune (would create an infinite loop).
  const resultRef = useRef<FolderCompareResult | null>(null);
  resultRef.current = result;

  // Mirror thumbCache to ref so onViewableItemsChanged stays stable (no stale closure).
  const thumbCacheRef = useRef<Map<string, string>>(thumbCache);
  thumbCacheRef.current = thumbCache;

  const abortRef = useRef<AbortController | null>(null);

  function ensureThumb(key: string, kind: 'image' | 'video' | 'other') {
    if (kind === 'other') return;
    if (thumbCacheRef.current.has(key)) return;
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
    setInFlightMoveKeys(new Set());
    setMoveJobIds(new Map());

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
      // Seed thumbCache with previewUrls from /list responses to avoid
      // a redundant signed-URL round-trip for files already in view.
      setThumbCache((prev) => {
        const seed = new Map(prev);
        for (const f of [...scanA.files, ...scanB.files]) {
          if (f.previewUrl && !seed.has(f.key)) {
            seed.set(f.key, f.previewUrl);
          }
        }
        return seed;
      });
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

  // ---- Decision helpers (stable callbacks for memo'd cards) ----

  const handleSetPairDecision = useCallback((etag: string, d: PairDecision) => {
    setPairDecisions((prev) => {
      const next = new Map(prev);
      next.set(etag, d);
      return next;
    });
  }, []);

  const handleClearPairDecision = useCallback((etag: string) => {
    setPairDecisions((prev) => { const next = new Map(prev); next.delete(etag); return next; });
  }, []);

  const handleSetOnlyADecision = useCallback((key: string, d: SingleDecision) => {
    setOnlyADecisions((prev) => {
      const next = new Map(prev);
      next.set(key, d);
      return next;
    });
  }, []);

  const handleClearOnlyADecision = useCallback((key: string) => {
    setOnlyADecisions((prev) => { const next = new Map(prev); next.delete(key); return next; });
  }, []);

  const handleSetOnlyBDecision = useCallback((key: string, d: SingleDecision) => {
    setOnlyBDecisions((prev) => {
      const next = new Map(prev);
      next.set(key, d);
      return next;
    });
  }, []);

  const handleClearOnlyBDecision = useCallback((key: string) => {
    setOnlyBDecisions((prev) => { const next = new Map(prev); next.delete(key); return next; });
  }, []);

  function setAllPairDecisions(kind: PairDecision['kind']): void {
    if (!result) return;
    const next = new Map<string, PairDecision>();
    for (const pair of result.shared) {
      next.set(pair.etag, { kind });
    }
    setPairDecisions(next);
  }

  function setAllSingleDecisions(
    files: ScannedFile[],
    setter: Dispatch<SetStateAction<Map<string, SingleDecision>>>,
    kind: SingleDecision['kind'],
  ): void {
    const next = new Map<string, SingleDecision>();
    for (const f of files) {
      next.set(f.key, { kind });
    }
    setter(next);
  }

  // ---- Stable renderThumb for memo'd cards ----

  const renderThumb = useCallback<RenderThumbFn>(
    (key, kind, previewUrl) => {
      const thumbUrl = thumbCache.get(key) ?? previewUrl;
      return (
        <View style={[cmpStyles.thumbSlot, { backgroundColor: colors.surfaceMuted }]}>
          {thumbUrl ? (
            <Image source={{ uri: thumbUrl }} style={cmpStyles.thumbImg} contentFit="cover" recyclingKey={key} />
          ) : (
            <Ionicons
              name={kind === 'video' ? 'videocam-outline' : 'image-outline'}
              size={20}
              color={colors.muted}
            />
          )}
        </View>
      );
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [thumbCache, colors],
  );

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
    const toDelete = result.onlyInA.filter((f) => onlyADecisions.get(f.key)?.kind === 'delete');
    const toMove = result.onlyInA.filter((f) => onlyADecisions.get(f.key)?.kind === 'move-to-other');

    if (toDelete.length === 0 && toMove.length === 0) {
      showAlert('No actions selected', 'Mark at least one file as Delete or Move to B in the "Only in A" section.');
      return;
    }

    const totalDeleteBytes = toDelete.reduce((acc, f) => acc + f.size, 0);

    if (toDelete.length > 0 && toMove.length > 0) {
      showAlert(
        `Delete ${toDelete.length} file(s) and move ${toMove.length} file(s) to "${nameB}"?`,
        `Frees ~${formatBytes(totalDeleteBytes)}. S3 versioning recommended.`,
        [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Apply', style: 'destructive', onPress: () => runApplySingleSection(toDelete, toMove, 'a') },
        ],
      );
    } else if (toMove.length > 0) {
      showAlert(
        `Move ${toMove.length} file(s) to "${nameB}"?`,
        '',
        [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Move', style: 'default', onPress: () => runApplySingleSection(toDelete, toMove, 'a') },
        ],
      );
    } else {
      showAlert(
        `Delete ${toDelete.length} file(s) from "${nameA}"?`,
        `Frees ~${formatBytes(totalDeleteBytes)}. S3 versioning recommended.`,
        [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Delete', style: 'destructive', onPress: () => runApplySingleSection(toDelete, toMove, 'a') },
        ],
      );
    }
  }

  async function runApplyOnlyB() {
    if (!result) return;
    const toDelete = result.onlyInB.filter((f) => onlyBDecisions.get(f.key)?.kind === 'delete');
    const toMove = result.onlyInB.filter((f) => onlyBDecisions.get(f.key)?.kind === 'move-to-other');

    if (toDelete.length === 0 && toMove.length === 0) {
      showAlert('No actions selected', 'Mark at least one file as Delete or Move to A in the "Only in B" section.');
      return;
    }

    const totalDeleteBytes = toDelete.reduce((acc, f) => acc + f.size, 0);

    if (toDelete.length > 0 && toMove.length > 0) {
      showAlert(
        `Delete ${toDelete.length} file(s) and move ${toMove.length} file(s) to "${nameA}"?`,
        `Frees ~${formatBytes(totalDeleteBytes)}. S3 versioning recommended.`,
        [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Apply', style: 'destructive', onPress: () => runApplySingleSection(toDelete, toMove, 'b') },
        ],
      );
    } else if (toMove.length > 0) {
      showAlert(
        `Move ${toMove.length} file(s) to "${nameA}"?`,
        '',
        [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Move', style: 'default', onPress: () => runApplySingleSection(toDelete, toMove, 'b') },
        ],
      );
    } else {
      showAlert(
        `Delete ${toDelete.length} file(s) from "${nameB}"?`,
        `Frees ~${formatBytes(totalDeleteBytes)}. S3 versioning recommended.`,
        [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Delete', style: 'destructive', onPress: () => runApplySingleSection(toDelete, toMove, 'b') },
        ],
      );
    }
  }

  async function runApplySingleSection(
    toDelete: ScannedFile[],
    toMove: ScannedFile[],
    side: 'a' | 'b',
  ) {
    setApplying(true);
    const fromPrefix = side === 'a' ? prefixA : prefixB;
    const toPrefix = side === 'a' ? prefixB : prefixA;

    const deleteTask =
      toDelete.length > 0
        ? api.delete({ keys: toDelete.map((f) => f.key) })
        : Promise.resolve(null);

    const moveTask =
      toMove.length > 0
        ? api.moveFolderKeys(fromPrefix, toPrefix, toMove.map((f) => f.key))
        : Promise.resolve(null);

    try {
      const [deleteResult, moveResult] = await Promise.allSettled([deleteTask, moveTask]);

      // Handle delete result.
      if (deleteResult.status === 'fulfilled' && deleteResult.value !== null) {
        const res = deleteResult.value;

        if (res.errors.length > 0) {
          const errList = res.errors
            .slice(0, 5)
            .map((e) => `• ${basename(e.key)}: ${e.message}`)
            .join('\n');
          showAlert(
            'Partial delete',
            `Deleted ${res.deleted.length} of ${toDelete.length}.\n${res.errors.length} failed:\n${errList}`,
          );
        }

        if (res.deleted.length > 0) {
          const deletedSet = new Set(res.deleted);
          const recoveredBytes = toDelete
            .filter((f) => deletedSet.has(f.key))
            .reduce((acc, f) => acc + f.size, 0);

          await appendAudit({
            action: 'delete-folder-compare',
            strategy: 'manual',
            keptKey: side === 'a' ? prefixB : prefixA,
            discardedKeys: res.deleted,
            recoveredBytes,
          });

          if (side === 'a') {
            setResult((prev) =>
              prev ? { ...prev, onlyInA: prev.onlyInA.filter((f) => !deletedSet.has(f.key)) } : prev,
            );
            setOnlyADecisions((prev) => {
              const next = new Map(prev);
              for (const k of deletedSet) next.delete(k);
              return next;
            });
          } else {
            setResult((prev) =>
              prev ? { ...prev, onlyInB: prev.onlyInB.filter((f) => !deletedSet.has(f.key)) } : prev,
            );
            setOnlyBDecisions((prev) => {
              const next = new Map(prev);
              for (const k of deletedSet) next.delete(k);
              return next;
            });
          }
        }
      } else if (deleteResult.status === 'rejected') {
        showAlert('Delete failed', deleteResult.reason instanceof Error ? deleteResult.reason.message : 'Unknown error');
      }

      // Handle move result.
      if (moveResult.status === 'fulfilled' && moveResult.value !== null) {
        const { jobId } = moveResult.value;
        const keysToMove = toMove.map((f) => f.key);

        await addJob(jobId, { fromPrefix, toPrefix });

        setInFlightMoveKeys((prev) => {
          const next = new Set(prev);
          for (const k of keysToMove) next.add(k);
          return next;
        });
        setMoveJobIds((prev) => {
          const next = new Map(prev);
          next.set(jobId, { side, keys: keysToMove });
          return next;
        });

        await appendAudit({
          action: 'move-folder-compare',
          strategy: 'manual',
          keptKey: toPrefix,
          discardedKeys: keysToMove,
          recoveredBytes: 0,
        });
      } else if (moveResult.status === 'rejected') {
        showAlert('Move failed', moveResult.reason instanceof Error ? moveResult.reason.message : 'Unknown error');
      }
    } finally {
      setApplying(false);
    }
  }

  // ---- Jobs-effect: prune terminal move jobs ----

  useEffect(() => {
    if (moveJobIds.size === 0) return;

    const COMPLETED_STATUSES = new Set(['completed', 'completed-with-errors']);
    const ABORTED_STATUSES = new Set(['cancelled', 'failed']);

    for (const [jobId, { side, keys: trackedKeys }] of moveJobIds) {
      const record = allJobs.find((j) => j.jobId === jobId);
      if (!record) continue;

      const isCompleted = COMPLETED_STATUSES.has(record.status);
      const isAborted = ABORTED_STATUSES.has(record.status);
      if (!isCompleted && !isAborted) continue;

      if (isCompleted) {
        const failedKeySet = new Set((record.failed ?? []).map((f) => f.key));
        const successKeys = trackedKeys.filter((k) => !failedKeySet.has(k));

        if (successKeys.length > 0) {
          const successSet = new Set(successKeys);
          if (side === 'a') {
            setResult((prev) =>
              prev ? { ...prev, onlyInA: prev.onlyInA.filter((f) => !successSet.has(f.key)) } : prev,
            );
            setOnlyADecisions((prev) => {
              const next = new Map(prev);
              for (const k of successSet) next.delete(k);
              return next;
            });
          } else {
            setResult((prev) =>
              prev ? { ...prev, onlyInB: prev.onlyInB.filter((f) => !successSet.has(f.key)) } : prev,
            );
            setOnlyBDecisions((prev) => {
              const next = new Map(prev);
              for (const k of successSet) next.delete(k);
              return next;
            });
          }
        }

        if (record.failed && record.failed.length > 0) {
          const sample = record.failed
            .slice(0, 5)
            .map((f) => `• ${basename(f.key)}: ${f.reason}`)
            .join('\n');
          showAlert(
            'Some moves failed',
            `${record.failed.length} of ${trackedKeys.length} file(s) could not be moved:\n${sample}`,
          );
        }
      } else {
        // Aborted — leave rows in place so user can retry.
        showAlert(
          record.status === 'cancelled' ? 'Move cancelled' : 'Move failed',
          record.error ?? 'The move job did not complete. The affected files are still in their original folder; rescan to re-evaluate.',
        );
      }

      setInFlightMoveKeys((prev) => {
        const next = new Set(prev);
        for (const k of trackedKeys) next.delete(k);
        return next;
      });

      setMoveJobIds((prev) => {
        const next = new Map(prev);
        next.delete(jobId);
        return next;
      });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allJobs, moveJobIds]);

  // ---- FlatList data + header ----

  const flatListData = useMemo((): CompareRow[] => {
    if (!result || !activeSection) return [];
    switch (activeSection) {
      case 'shared':
        return result.shared.map((pair) => ({ type: 'pair', key: pair.etag, pair }));
      case 'only-a':
        return result.onlyInA.map((file) => ({ type: 'single-a', key: `a:${file.key}`, file }));
      case 'only-b':
        return result.onlyInB.map((file) => ({ type: 'single-b', key: `b:${file.key}`, file }));
      case 'uncomparable':
        return [
          ...result.uncomparable.a.map((file) => ({ type: 'uncomparable' as const, key: `u:${file.key}`, file })),
          ...result.uncomparable.b.map((file) => ({ type: 'uncomparable' as const, key: `u:${file.key}`, file })),
        ];
    }
  }, [result, activeSection]);

  // Invalidates memo'd cards when decisions, thumb cache, or in-flight state changes.
  const extraData = useMemo(
    () => ({ pairDecisions, onlyADecisions, onlyBDecisions, thumbCache, inFlightMoveKeys, applying }),
    [pairDecisions, onlyADecisions, onlyBDecisions, thumbCache, inFlightMoveKeys, applying],
  );

  const listHeader = useMemo(() => {
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

    const summaryEl = (
      <View style={{ gap: Spacing.xs }}>
        {sections.map((s) => (
          <Pressable
            key={s.id}
            onPress={() => setActiveSection((cur) => (cur === s.id ? null : s.id))}
            style={({ pressed }) => [
              cmpStyles.summaryRow,
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

    // Bulk-action bar + apply button for whichever section is expanded.
    let bulkEl: React.ReactNode = null;

    if (activeSection === 'shared') {
      const actionable = shared.filter((p) => {
        const d = pairDecisions.get(p.etag);
        return d && d.kind !== 'skip';
      });
      bulkEl = (
        <View style={{ gap: Spacing.sm, marginTop: Spacing.sm }}>
          <View style={cmpStyles.bulkBar}>
            {(
              [
                { kind: 'keep-a' as const, label: 'Keep all from A' },
                { kind: 'keep-b' as const, label: 'Keep all from B' },
                { kind: 'skip' as const, label: 'Skip all' },
              ] as const
            ).map(({ kind, label }) => (
              <Pressable
                key={kind}
                onPress={() => setAllPairDecisions(kind)}
                disabled={applying}
                style={({ pressed }) => [
                  cmpStyles.actionChip,
                  { backgroundColor: colors.surfaceMuted, opacity: applying || pressed ? 0.7 : 1 },
                ]}>
                <ThemedText style={[Type.meta, { color: colors.text }]}>{label}</ThemedText>
              </Pressable>
            ))}
          </View>
          {actionable.length > 0 && (
            <Pressable
              onPress={runApplyShared}
              disabled={applying}
              style={({ pressed }) => [
                cmpStyles.applyButton,
                { backgroundColor: colors.danger, opacity: applying || pressed ? 0.7 : 1 },
              ]}>
              <ThemedText style={[Type.label, { color: colors.onAccent, fontWeight: '600' }]}>
                Apply {actionable.length} decision(s) — delete chosen files
              </ThemedText>
            </Pressable>
          )}
          {shared.length === 0 && (
            <View style={cmpStyles.emptySection}>
              <ThemedText style={[Type.meta, { color: colors.muted }]}>No shared files found.</ThemedText>
            </View>
          )}
        </View>
      );
    } else if (activeSection === 'only-a' || activeSection === 'only-b') {
      const isA = activeSection === 'only-a';
      const files = isA ? onlyInA : onlyInB;
      const sectionDecisions = isA ? onlyADecisions : onlyBDecisions;
      const onApply = isA ? runApplyOnlyA : runApplyOnlyB;
      const otherName = isA ? nameB : nameA;
      const emptyMsg = isA
        ? `No files found only in "${nameA}".`
        : `No files found only in "${nameB}".`;

      const toDeleteCount = files.filter((f) => sectionDecisions.get(f.key)?.kind === 'delete').length;
      const toMoveCount = files.filter((f) => sectionDecisions.get(f.key)?.kind === 'move-to-other').length;

      let applyLabel: string | null = null;
      let applyBgColor = colors.danger;
      if (toDeleteCount > 0 && toMoveCount > 0) {
        applyLabel = `Apply ${toDeleteCount} delete(s) + ${toMoveCount} move(s)`;
        applyBgColor = colors.danger;
      } else if (toMoveCount > 0) {
        applyLabel = `Move ${toMoveCount} selected file(s) to "${otherName}"`;
        applyBgColor = colors.tint;
      } else if (toDeleteCount > 0) {
        applyLabel = `Delete ${toDeleteCount} selected file(s)`;
        applyBgColor = colors.danger;
      }

      bulkEl = (
        <View style={{ gap: Spacing.sm, marginTop: Spacing.sm }}>
          <View style={cmpStyles.bulkBar}>
            {(
              [
                { kind: 'delete' as const, label: 'Delete all' },
                { kind: 'move-to-other' as const, label: `Move all to ${otherName}` },
                { kind: 'skip' as const, label: 'Keep all' },
              ] as const
            ).map(({ kind, label }) => (
              <Pressable
                key={kind}
                onPress={() =>
                  setAllSingleDecisions(
                    files,
                    isA ? setOnlyADecisions : setOnlyBDecisions,
                    kind,
                  )
                }
                disabled={applying}
                style={({ pressed }) => [
                  cmpStyles.actionChip,
                  { backgroundColor: colors.surfaceMuted, opacity: applying || pressed ? 0.7 : 1 },
                ]}>
                <ThemedText style={[Type.meta, { color: colors.text }]}>{label}</ThemedText>
              </Pressable>
            ))}
          </View>
          {applyLabel !== null && (
            <Pressable
              onPress={onApply}
              disabled={applying}
              style={({ pressed }) => [
                cmpStyles.applyButton,
                { backgroundColor: applyBgColor, opacity: applying || pressed ? 0.7 : 1 },
              ]}>
              <ThemedText style={[Type.label, { color: colors.onAccent, fontWeight: '600' }]}>
                {applyLabel}
              </ThemedText>
            </Pressable>
          )}
          {files.length === 0 && (
            <View style={cmpStyles.emptySection}>
              <ThemedText style={[Type.meta, { color: colors.muted }]}>{emptyMsg}</ThemedText>
            </View>
          )}
        </View>
      );
    } else if (activeSection === 'uncomparable') {
      const allUncomparable = [...uncomparable.a, ...uncomparable.b];
      bulkEl = (
        <View style={{ gap: Spacing.sm, marginTop: Spacing.sm }}>
          {allUncomparable.length === 0 ? (
            <View style={cmpStyles.emptySection}>
              <ThemedText style={[Type.meta, { color: colors.muted }]}>
                All files had comparable ETags.
              </ThemedText>
            </View>
          ) : (
            <ThemedText style={[Type.meta, { color: colors.muted, marginBottom: Spacing.xs }]}>
              These files were skipped because their ETag is missing or is a multipart ETag
              (e.g. uploaded in multiple parts), which cannot be compared reliably across clients.
              They are shown for reference only.
            </ThemedText>
          )}
        </View>
      );
    }

    return (
      <View style={{ gap: Spacing.xs }}>
        {summaryEl}
        {bulkEl}
      </View>
    );
  // We need pairDecisions, applying etc. in scope for the bulk bar — include
  // all values that affect the header UI so it stays fresh.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result, activeSection, pairDecisions, onlyADecisions, onlyBDecisions, applying, colors, nameA, nameB]);

  // ---- Viewability-driven lazy thumb fetch ----

  const viewabilityConfig = useRef({ itemVisiblePercentThreshold: 10 }).current;

  const onViewableItemsChanged = useCallback(
    ({ viewableItems }: { viewableItems: Array<{ item: CompareRow }> }) => {
      for (const { item: row } of viewableItems) {
        if (row.type === 'pair') {
          for (const f of [row.pair.a, row.pair.b]) {
            if (f.kind === 'other') continue;
            if (thumbCacheRef.current.has(f.key) || f.previewUrl) continue;
            ensureThumb(f.key, f.kind);
          }
        } else if (row.type === 'single-a' || row.type === 'single-b') {
          const f = row.file;
          if (f.kind === 'other') continue;
          if (thumbCacheRef.current.has(f.key) || f.previewUrl) continue;
          ensureThumb(f.key, f.kind);
        }
        // 'uncomparable' files never have thumbnails
      }
    },
    // ensureThumb is stable; thumbCacheRef is always current via ref pattern.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  // ---- renderItem for FlatList ----

  const renderItem = useCallback(
    ({ item: row }: { item: CompareRow }) => {
      if (row.type === 'pair') {
        return (
          <PairCard
            pair={row.pair}
            decision={pairDecisions.get(row.pair.etag)}
            applying={applying}
            colors={colors}
            renderThumb={renderThumb}
            onSetDecision={handleSetPairDecision}
            onClearDecision={handleClearPairDecision}
          />
        );
      }
      if (row.type === 'single-a') {
        return (
          <SingleCard
            file={row.file}
            decision={onlyADecisions.get(row.file.key)}
            applying={applying}
            isInFlight={inFlightMoveKeys.has(row.file.key)}
            colors={colors}
            otherName={nameB}
            renderThumb={renderThumb}
            onSetDecision={handleSetOnlyADecision}
            onClearDecision={handleClearOnlyADecision}
          />
        );
      }
      if (row.type === 'single-b') {
        return (
          <SingleCard
            file={row.file}
            decision={onlyBDecisions.get(row.file.key)}
            applying={applying}
            isInFlight={inFlightMoveKeys.has(row.file.key)}
            colors={colors}
            otherName={nameA}
            renderThumb={renderThumb}
            onSetDecision={handleSetOnlyBDecision}
            onClearDecision={handleClearOnlyBDecision}
          />
        );
      }
      // uncomparable
      return <UncomparableCard file={row.file} colors={colors} />;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [extraData, colors, nameA, nameB, renderThumb,
      handleSetPairDecision, handleClearPairDecision,
      handleSetOnlyADecision, handleClearOnlyADecision,
      handleSetOnlyBDecision, handleClearOnlyBDecision],
  );

  // ---- Main render ----

  return (
    <ThemedView style={cmpStyles.container}>
      {/* S3 versioning advisory banner */}
      <View style={[cmpStyles.banner, { backgroundColor: colors.accentSoft }]}>
        <Ionicons name="shield-checkmark-outline" size={16} color={colors.tint} />
        <ThemedText style={[Type.meta, { color: colors.tint, flex: 1 }]}>
          Enable S3 versioning before deleting — it lets you restore files if you change your mind.
        </ThemedText>
      </View>

      {/* Folder label bar */}
      <View style={[cmpStyles.folderBar, { backgroundColor: colors.surfaceMuted }]}>
        <View style={cmpStyles.folderChip}>
          <View style={[cmpStyles.sideLabel, { backgroundColor: colors.accentSoft }]}>
            <ThemedText style={[Type.meta, { color: colors.tint, fontWeight: '600' }]}>A</ThemedText>
          </View>
          <ThemedText style={[Type.meta, { color: colors.text }]} numberOfLines={1}>{nameA}</ThemedText>
        </View>
        <ThemedText style={[Type.meta, { color: colors.muted }]}>vs</ThemedText>
        <View style={cmpStyles.folderChip}>
          <View style={[cmpStyles.sideLabel, { backgroundColor: colors.surfaceMuted }]}>
            <ThemedText style={[Type.meta, { color: colors.muted, fontWeight: '600' }]}>B</ThemedText>
          </View>
          <ThemedText style={[Type.meta, { color: colors.text }]} numberOfLines={1}>{nameB}</ThemedText>
        </View>
      </View>

      {scanState === 'idle' && (
        <View style={cmpStyles.center}>
          <Pressable
            onPress={startScan}
            style={({ pressed }) => [
              cmpStyles.scanButton,
              { backgroundColor: colors.tint, opacity: pressed ? 0.8 : 1 },
            ]}>
            <Ionicons name="git-compare-outline" size={20} color={colors.onAccent} />
            <ThemedText style={[Type.bodyStrong, { color: colors.onAccent }]}>Compare folders</ThemedText>
          </Pressable>
        </View>
      )}

      {scanState === 'scanning' && (
        <View style={cmpStyles.center}>
          <ActivityIndicator size="large" color={colors.tint} />
          <ThemedText style={[Type.body, { color: colors.text, marginTop: Spacing.md }]}>
            Scanning…
          </ThemedText>
          <ThemedText style={[Type.meta, { color: colors.muted, marginTop: Spacing.xs }]}>
            A: {progressA.filesScanned} files · B: {progressB.filesScanned} files
          </ThemedText>
          <Pressable onPress={cancelScan} style={cmpStyles.cancelLink}>
            <ThemedText style={[Type.label, { color: colors.danger }]}>Cancel</ThemedText>
          </Pressable>
        </View>
      )}

      {scanState === 'error' && (
        <View style={cmpStyles.center}>
          <ThemedText style={{ color: colors.danger }}>{scanError}</ThemedText>
          <Pressable
            onPress={startScan}
            style={({ pressed }) => [
              cmpStyles.retryButton,
              { borderColor: colors.tint, opacity: pressed ? 0.7 : 1 },
            ]}>
            <ThemedText style={{ color: colors.tint, fontWeight: '600' }}>Retry</ThemedText>
          </Pressable>
        </View>
      )}

      {scanState === 'done' && result && (
        <FlatList<CompareRow>
          data={flatListData}
          keyExtractor={(row) => row.key}
          renderItem={renderItem}
          extraData={extraData}
          ListHeaderComponent={listHeader}
          contentContainerStyle={cmpStyles.listContent}
          viewabilityConfig={viewabilityConfig}
          onViewableItemsChanged={onViewableItemsChanged}
        />
      )}

      {/* Overlay rendered AFTER FlatList so last-paint wins on Android */}
      {applying && (
        <View style={cmpStyles.busyOverlay}>
          <ThemedView style={cmpStyles.busyCard}>
            <ActivityIndicator />
            <ThemedText>Applying…</ThemedText>
          </ThemedView>
        </View>
      )}
    </ThemedView>
  );
}

const cmpStyles = StyleSheet.create({
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
  listContent: {
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
  bulkBar: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: Spacing.xs,
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
