import { Image } from 'expo-image';
import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  View,
} from 'react-native';

import { FolderPicker } from '@/components/folder-picker';
import { PreviewModal, type PreviewFile } from '@/components/preview-modal';
import { RenameModal } from '@/components/rename-modal';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { IconSymbol } from '@/components/ui/icon-symbol';
import { Colors } from '@/constants/theme';
import { useColorScheme } from '@/hooks/use-color-scheme';
import { api, ApiError, type ListResponse } from '@/lib/api';
import { loadConfig } from '@/lib/config';
import { basename, dirname, formatBytes, splitPathSegments } from '@/lib/format';

const THUMB_SIZE = 56;

type Row =
  | { kind: 'folder'; prefix: string; name: string }
  | {
      kind: 'file';
      key: string;
      name: string;
      size: number;
      lastModified: string;
      mediaKind: 'image' | 'video' | 'other';
      previewUrl?: string;
    };

type Selection = { files: Set<string>; folders: Set<string> };

const emptySelection = (): Selection => ({ files: new Set(), folders: new Set() });

type SortField = 'name' | 'date' | 'size';
type SortDir = 'asc' | 'desc';

const SORT_LABELS: Record<SortField, string> = {
  name: 'Name',
  date: 'Date',
  size: 'Size',
};

function compareRows(a: Row, b: Row, field: SortField, dir: SortDir): number {
  if (a.kind === 'folder' && b.kind !== 'folder') return -1;
  if (a.kind !== 'folder' && b.kind === 'folder') return 1;

  let cmp = 0;
  if (a.kind === 'folder' && b.kind === 'folder') {
    cmp = a.name.localeCompare(b.name);
  } else if (a.kind === 'file' && b.kind === 'file') {
    if (field === 'name') cmp = a.name.localeCompare(b.name);
    else if (field === 'date') cmp = (a.lastModified || '').localeCompare(b.lastModified || '');
    else if (field === 'size') cmp = a.size - b.size;
  }
  return dir === 'asc' ? cmp : -cmp;
}

export default function BrowseScreen() {
  const colorScheme = useColorScheme() ?? 'light';
  const colors = Colors[colorScheme];

  const [path, setPath] = useState('');
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [previewIndex, setPreviewIndex] = useState<number | null>(null);

  const [selection, setSelection] = useState<Selection>(emptySelection);
  const [moveDestVisible, setMoveDestVisible] = useState(false);
  const [renameVisible, setRenameVisible] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [sortField, setSortField] = useState<SortField>('name');
  const [sortDir, setSortDir] = useState<SortDir>('asc');

  const selectionCount = selection.files.size + selection.folders.size;
  const selectionActive = selectionCount > 0;

  const sortedRows = [...rows].sort((a, b) => compareRows(a, b, sortField, sortDir));

  function cycleSortField() {
    setSortField((f) => (f === 'name' ? 'date' : f === 'date' ? 'size' : 'name'));
  }

  function toggleSortDir() {
    setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
  }

  function selectAll() {
    const files = new Set<string>();
    const folders = new Set<string>();
    for (const row of rows) {
      if (row.kind === 'folder') folders.add(row.prefix);
      else files.add(row.key);
    }
    setSelection({ files, folders });
  }

  const allSelected =
    rows.length > 0 && selectionCount === rows.length;

  const previewFiles: PreviewFile[] = sortedRows
    .filter((r): r is Extract<Row, { kind: 'file' }> => r.kind === 'file')
    .map((r) => ({ key: r.key, kind: r.mediaKind }));

  const singleSelected: { kind: 'file'; key: string } | { kind: 'folder'; prefix: string } | null =
    selectionCount === 1
      ? selection.files.size === 1
        ? { kind: 'file', key: Array.from(selection.files)[0]! }
        : { kind: 'folder', prefix: Array.from(selection.folders)[0]! }
      : null;

  const renameInitial = singleSelected
    ? singleSelected.kind === 'file'
      ? basename(singleSelected.key)
      : basename(singleSelected.prefix.replace(/\/$/, ''))
    : '';

  async function runRename(newName: string) {
    setRenameVisible(false);
    if (!singleSelected) return;
    const trimmed = newName.trim();
    if (!trimmed || trimmed.includes('/')) {
      Alert.alert('Invalid name', 'Name cannot be empty or contain "/".');
      return;
    }
    setBusy('Renaming…');
    try {
      if (singleSelected.kind === 'file') {
        const dest = dirname(singleSelected.key) + trimmed;
        await api.moveFile(singleSelected.key, dest);
      } else {
        const parent = dirname(singleSelected.prefix.replace(/\/$/, ''));
        const dest = parent + trimmed + '/';
        await api.moveFolder(singleSelected.prefix, dest);
      }
      setSelection(emptySelection());
      await load(path, 'refresh');
    } catch (err) {
      Alert.alert(
        'Rename failed',
        err instanceof Error ? err.message : 'Unknown error',
      );
    } finally {
      setBusy(null);
    }
  }

  const load = useCallback(async (prefix: string, mode: 'fresh' | 'refresh' = 'fresh') => {
    const cfg = await loadConfig();
    if (!cfg) {
      setError('Not configured. Open the Settings tab and add your backend URL + token.');
      setRows([]);
      return;
    }
    if (mode === 'fresh') setLoading(true);
    setError(null);
    try {
      const res: ListResponse = await api.list(prefix);
      const folderRows: Row[] = res.folders.map((p) => ({
        kind: 'folder',
        prefix: p,
        name: basename(p),
      }));
      const fileRows: Row[] = res.files.map((f) => ({
        kind: 'file',
        key: f.key,
        name: basename(f.key),
        size: f.size,
        lastModified: f.lastModified,
        mediaKind: f.kind,
        previewUrl: f.previewUrl,
      }));
      setRows([...folderRows, ...fileRows]);
    } catch (err) {
      const message =
        err instanceof ApiError
          ? `(${err.status}) ${err.message}`
          : err instanceof Error
            ? err.message
            : 'Unknown error';
      setError(message);
      setRows([]);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    load(path);
    setSelection(emptySelection());
  }, [path, load]);

  function onRefresh() {
    setRefreshing(true);
    load(path, 'refresh');
  }

  function toggleRow(row: Row) {
    setSelection((prev) => {
      const files = new Set(prev.files);
      const folders = new Set(prev.folders);
      if (row.kind === 'folder') {
        if (folders.has(row.prefix)) folders.delete(row.prefix);
        else folders.add(row.prefix);
      } else {
        if (files.has(row.key)) files.delete(row.key);
        else files.add(row.key);
      }
      return { files, folders };
    });
  }

  function onTapRow(row: Row) {
    if (selectionActive) {
      toggleRow(row);
      return;
    }
    if (row.kind === 'folder') setPath(row.prefix);
    else {
      const idx = previewFiles.findIndex((f) => f.key === row.key);
      if (idx >= 0) setPreviewIndex(idx);
    }
  }

  function onLongPressRow(row: Row) {
    if (selectionActive) return;
    const s = emptySelection();
    if (row.kind === 'folder') s.folders.add(row.prefix);
    else s.files.add(row.key);
    setSelection(s);
  }

  function isSelected(row: Row): boolean {
    return row.kind === 'folder'
      ? selection.folders.has(row.prefix)
      : selection.files.has(row.key);
  }

  function confirmDelete() {
    const fileCount = selection.files.size;
    const folderCount = selection.folders.size;
    const message =
      folderCount > 0
        ? `Delete ${selectionCount} item(s)? This permanently removes ${fileCount} file(s) and everything inside ${folderCount} folder(s).`
        : `Delete ${fileCount} file(s)? This can't be undone.`;
    Alert.alert('Confirm delete', message, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: runDelete },
    ]);
  }

  async function runDelete() {
    const keys = Array.from(selection.files);
    const prefixes = Array.from(selection.folders);
    setBusy(`Deleting ${selectionCount} item(s)…`);
    try {
      const res = await api.delete({ keys, prefixes });
      if (res.errors.length > 0) {
        Alert.alert(
          'Partial delete',
          `Deleted ${res.deleted.length} object(s). ${res.errors.length} failed:\n` +
            res.errors
              .slice(0, 5)
              .map((e) => `• ${e.key}: ${e.message}`)
              .join('\n'),
        );
      }
      setSelection(emptySelection());
      await load(path, 'refresh');
    } catch (err) {
      Alert.alert(
        'Delete failed',
        err instanceof Error ? err.message : 'Unknown error',
      );
    } finally {
      setBusy(null);
    }
  }

  async function runMove(destPrefix: string) {
    setMoveDestVisible(false);
    const files = Array.from(selection.files);
    const folders = Array.from(selection.folders);
    const total = files.length + folders.length;
    if (total === 0) return;

    setBusy(`Moving 0 of ${total}…`);
    let done = 0;
    let failed: Array<{ src: string; message: string }> = [];

    for (const key of files) {
      const dest = destPrefix + basename(key);
      try {
        await api.moveFile(key, dest);
      } catch (err) {
        failed.push({ src: key, message: err instanceof Error ? err.message : 'failed' });
      }
      done += 1;
      setBusy(`Moving ${done} of ${total}…`);
    }

    for (const prefix of folders) {
      const folderName = basename(prefix.replace(/\/$/, ''));
      const dest = destPrefix + folderName + '/';
      try {
        await api.moveFolder(prefix, dest);
      } catch (err) {
        failed.push({ src: prefix, message: err instanceof Error ? err.message : 'failed' });
      }
      done += 1;
      setBusy(`Moving ${done} of ${total}…`);
    }

    setBusy(null);
    setSelection(emptySelection());
    await load(path, 'refresh');

    if (failed.length > 0) {
      Alert.alert(
        'Partial move',
        `${total - failed.length} succeeded, ${failed.length} failed:\n` +
          failed
            .slice(0, 5)
            .map((f) => `• ${f.src}: ${f.message}`)
            .join('\n'),
      );
    }
  }

  const segments = splitPathSegments(path);

  return (
    <ThemedView style={styles.container}>
      {selectionActive ? (
        <View style={[styles.selectionHeader, { borderColor: colors.icon }]}>
          <Pressable onPress={() => setSelection(emptySelection())} hitSlop={8}>
            <ThemedText style={{ color: colors.tint, fontSize: 16 }}>Cancel</ThemedText>
          </Pressable>
          <ThemedText type="defaultSemiBold">{selectionCount} selected</ThemedText>
          <Pressable
            onPress={allSelected ? () => setSelection(emptySelection()) : selectAll}
            hitSlop={8}>
            <ThemedText style={{ color: colors.tint, fontSize: 16 }}>
              {allSelected ? 'None' : 'All'}
            </ThemedText>
          </Pressable>
        </View>
      ) : (
        <>
          <Breadcrumb
            segments={segments}
            onTap={(segs) => setPath(segs.length === 0 ? '' : segs.join('/') + '/')}
            accent={colors.tint}
            muted={colors.icon}
          />
          {rows.length > 0 && (
            <View style={[styles.sortBar, { borderColor: colors.icon }]}>
              <ThemedText style={styles.sortLabel}>Sort</ThemedText>
              <Pressable
                onPress={cycleSortField}
                style={({ pressed }) => [
                  styles.sortChip,
                  { borderColor: colors.tint, opacity: pressed ? 0.6 : 1 },
                ]}>
                <ThemedText style={{ color: colors.tint, fontWeight: '600' }}>
                  {SORT_LABELS[sortField]}
                </ThemedText>
              </Pressable>
              <Pressable
                onPress={toggleSortDir}
                style={({ pressed }) => [
                  styles.sortChip,
                  { borderColor: colors.tint, opacity: pressed ? 0.6 : 1 },
                ]}
                accessibilityLabel={`Sort direction: ${sortDir === 'asc' ? 'ascending' : 'descending'}`}>
                <ThemedText style={{ color: colors.tint, fontWeight: '600' }}>
                  {sortDir === 'asc' ? '↑' : '↓'}
                </ThemedText>
              </Pressable>
            </View>
          )}
        </>
      )}

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator />
        </View>
      ) : error ? (
        <View style={[styles.center, { padding: 24 }]}>
          <ThemedText style={{ textAlign: 'center', opacity: 0.8 }}>{error}</ThemedText>
          <Pressable
            onPress={() => load(path)}
            style={({ pressed }) => [
              styles.retryButton,
              { borderColor: colors.tint, opacity: pressed ? 0.7 : 1 },
            ]}>
            <ThemedText style={{ color: colors.tint, fontWeight: '600' }}>Retry</ThemedText>
          </Pressable>
        </View>
      ) : (
        <FlatList
          data={sortedRows}
          keyExtractor={(item) => (item.kind === 'folder' ? `f:${item.prefix}` : `k:${item.key}`)}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
          ListEmptyComponent={
            <ThemedText style={styles.empty}>This folder is empty.</ThemedText>
          }
          renderItem={({ item }) => {
            const selected = isSelected(item);
            const isFolder = item.kind === 'folder';
            return (
              <Pressable
                onPress={() => onTapRow(item)}
                onLongPress={() => onLongPressRow(item)}
                style={({ pressed }) => [
                  styles.row,
                  {
                    borderColor: colors.icon,
                    backgroundColor: selected ? colors.tint + '22' : undefined,
                    opacity: pressed ? 0.6 : 1,
                  },
                ]}>
                {selectionActive && (
                  <View
                    style={[
                      styles.checkbox,
                      {
                        borderColor: selected ? colors.tint : colors.icon,
                        backgroundColor: selected ? colors.tint : 'transparent',
                      },
                    ]}>
                    {selected && (
                      <ThemedText
                        lightColor="#fff"
                        darkColor="#000"
                        style={styles.checkboxMark}>
                        ✓
                      </ThemedText>
                    )}
                  </View>
                )}
                {isFolder ? (
                  <View style={styles.thumbSlot}>
                    <IconSymbol name="folder" size={28} color={colors.icon} />
                  </View>
                ) : item.previewUrl ? (
                  <Image
                    source={{ uri: item.previewUrl }}
                    style={styles.thumb}
                    contentFit="cover"
                    transition={120}
                    recyclingKey={item.key}
                    cachePolicy="memory-disk"
                  />
                ) : item.mediaKind === 'video' ? (
                  <View style={[styles.thumb, styles.videoThumb]}>
                    <ThemedText
                      lightColor="#fff"
                      darkColor="#fff"
                      style={styles.videoThumbText}>
                      ▶
                    </ThemedText>
                  </View>
                ) : (
                  <View style={styles.thumbSlot}>
                    <IconSymbol name="photo.on.rectangle" size={28} color={colors.icon} />
                  </View>
                )}
                <View style={{ flex: 1 }}>
                  <ThemedText style={styles.rowLabel} numberOfLines={1}>
                    {item.name}
                  </ThemedText>
                  {!isFolder && (
                    <ThemedText style={styles.rowMeta}>
                      {formatBytes(item.size)} · {formatDate(item.lastModified)}
                    </ThemedText>
                  )}
                </View>
                {!selectionActive && isFolder && (
                  <IconSymbol name="chevron.right" size={18} color={colors.icon} />
                )}
              </Pressable>
            );
          }}
        />
      )}

      {selectionActive && (
        <View
          style={[
            styles.actionBar,
            { backgroundColor: colors.background, borderColor: colors.icon },
          ]}>
          {singleSelected && (
            <Pressable
              onPress={() => setRenameVisible(true)}
              style={({ pressed }) => [
                styles.actionButton,
                { borderColor: colors.tint, opacity: pressed ? 0.7 : 1 },
              ]}>
              <ThemedText style={{ color: colors.tint, fontWeight: '600' }}>Rename</ThemedText>
            </Pressable>
          )}
          <Pressable
            onPress={() => setMoveDestVisible(true)}
            style={({ pressed }) => [
              styles.actionButton,
              { borderColor: colors.tint, opacity: pressed ? 0.7 : 1 },
            ]}>
            <ThemedText style={{ color: colors.tint, fontWeight: '600' }}>Move…</ThemedText>
          </Pressable>
          <Pressable
            onPress={confirmDelete}
            style={({ pressed }) => [
              styles.actionButton,
              { borderColor: '#c0392b', opacity: pressed ? 0.7 : 1 },
            ]}>
            <ThemedText style={{ color: '#c0392b', fontWeight: '600' }}>Delete</ThemedText>
          </Pressable>
        </View>
      )}

      <PreviewModal
        visible={previewIndex !== null}
        files={previewFiles}
        initialIndex={previewIndex}
        onClose={() => setPreviewIndex(null)}
      />

      <FolderPicker
        visible={moveDestVisible}
        onClose={() => setMoveDestVisible(false)}
        onPick={runMove}
      />

      <RenameModal
        visible={renameVisible}
        title={
          singleSelected?.kind === 'folder' ? 'Rename folder' : 'Rename file'
        }
        initialValue={renameInitial}
        onCancel={() => setRenameVisible(false)}
        onSubmit={runRename}
      />

      {busy && (
        <View style={styles.busyOverlay}>
          <ThemedView style={styles.busyCard}>
            <ActivityIndicator />
            <ThemedText>{busy}</ThemedText>
          </ThemedView>
        </View>
      )}
    </ThemedView>
  );
}

function Breadcrumb({
  segments,
  onTap,
  accent,
  muted,
}: {
  segments: string[];
  onTap: (segments: string[]) => void;
  accent: string;
  muted: string;
}) {
  return (
    <View style={[styles.breadcrumb, { borderColor: muted }]}>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.breadcrumbInner}>
        <Pressable onPress={() => onTap([])} accessibilityRole="button">
          <ThemedText style={{ color: accent, fontWeight: '600' }}>/ root</ThemedText>
        </Pressable>
        {segments.map((seg, i) => {
          const upto = segments.slice(0, i + 1);
          const isLast = i === segments.length - 1;
          return (
            <View key={i} style={{ flexDirection: 'row', alignItems: 'center' }}>
              <ThemedText style={{ marginHorizontal: 4, opacity: 0.5 }}>/</ThemedText>
              <Pressable onPress={() => onTap(upto)} accessibilityRole="button">
                <ThemedText style={{ color: isLast ? undefined : accent }}>{seg}</ThemedText>
              </Pressable>
            </View>
          );
        })}
      </ScrollView>
    </View>
  );
}

function formatDate(iso: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString();
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12 },
  breadcrumb: {
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  breadcrumbInner: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  selectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  checkbox: {
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkboxMark: { fontWeight: '700', fontSize: 13 },
  rowLabel: { fontSize: 16 },
  rowMeta: { fontSize: 12, opacity: 0.6, marginTop: 2 },
  thumb: {
    width: THUMB_SIZE,
    height: THUMB_SIZE,
    borderRadius: 6,
    backgroundColor: 'rgba(0,0,0,0.05)',
  },
  thumbSlot: {
    width: THUMB_SIZE,
    height: THUMB_SIZE,
    alignItems: 'center',
    justifyContent: 'center',
  },
  videoThumb: {
    backgroundColor: '#1a1a1a',
    alignItems: 'center',
    justifyContent: 'center',
  },
  videoThumbText: { fontSize: 22 },
  sortBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  sortLabel: { fontSize: 13, opacity: 0.6 },
  sortChip: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 14,
    borderWidth: 1,
  },
  empty: { textAlign: 'center', opacity: 0.6, padding: 32 },
  retryButton: {
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderRadius: 8,
    borderWidth: 1,
  },
  actionBar: {
    flexDirection: 'row',
    gap: 12,
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 28,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  actionButton: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 8,
    borderWidth: 1,
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
    padding: 24,
    borderRadius: 12,
    gap: 12,
    alignItems: 'center',
    minWidth: 200,
  },
});
