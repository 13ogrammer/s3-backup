import { useFocusEffect, useNavigation, useRouter } from 'expo-router';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  BackHandler,
  Dimensions,
  FlatList,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  View,
} from 'react-native';

import { useAiFabClearance } from '@/components/ai-fab';
import { ActionSheet } from '@/components/action-sheet';
import { BottomSheet } from '@/components/bottom-sheet';
import { SelectionActionBar, type SelectionAction } from '@/components/selection-action-bar';
import { FolderThumb } from '@/components/FolderThumb';
import { FolderPicker } from '@/components/folder-picker';
import { PreviewModal, type PreviewFile } from '@/components/preview-modal';
import { RenameModal } from '@/components/rename-modal';
import { SearchModal } from '@/components/search-modal';
import { ThemedText } from '@/components/themed-text';
import { Thumb } from '@/components/Thumb';
import { ThemedView } from '@/components/themed-view';
import { useAlert } from '@/components/ui/alert-provider';
import { IconSymbol } from '@/components/ui/icon-symbol';
import { Colors, Radius, Shadow, Spacing } from '@/constants/theme';
import { useColorScheme } from '@/hooks/use-color-scheme';
import { api, ApiError, isUserActionableError, isFolderTooLargeError, type ListResponse, type GetDerivedUrlResponse, type FolderPreviewThumb, type FolderCounts, type FolderTooLargeErrorBody, type MergePolicy } from '@/lib/api';
import { getAssistantMutationVersion, setAssistantContextPrefix } from '@/lib/assistantConfig';
import { useJobs } from '@/lib/jobs';
import { loadConfig } from '@/lib/config';
import { basename, dirname, formatBytes, splitPathSegments } from '@/lib/format';
import { fromErr, recordMoveFailure, recordMoveSuccess, recordMergeFolderSuccess, toReason } from '@/lib/activityLog';
import { detectCollisions } from '@/lib/mergePrecheck';
import { MergePolicyModal } from '@/components/merge-policy-modal';
import type { CollisionReport } from '@/lib/mergePrecheck';
import { captureApiError } from '@/lib/sentry';

const THUMB_SIZE = 56;
const GRID_COLUMNS = 3;
const FOLDER_VIEWABILITY_CONFIG = {
  itemVisiblePercentThreshold: 30,
  minimumViewTime: 100,
} as const;
const GRID_SPACING = 4;
const GRID_TILE =
  (Dimensions.get('window').width - GRID_SPACING * (GRID_COLUMNS + 1)) / GRID_COLUMNS;

type ViewMode = 'list' | 'grid';

type Row =
  | { kind: 'folder'; prefix: string; name: string }
  | {
      kind: 'file';
      key: string;
      name: string;
      size: number;
      lastModified: string;
      // S3B-34: populated for files uploaded after S3B-34; undefined for older
      // files. compareRows falls back to lastModified when undefined.
      createdAt?: string;
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
    else if (field === 'date') {
      // Prefer createdAt (from EXIF/media-library, written on upload by S3B-34).
      // Falls back to lastModified for pre-S3B-34 files — no error, just
      // sorts by S3's own last-modified timestamp in that case.
      const aDate = a.createdAt ?? a.lastModified;
      const bDate = b.createdAt ?? b.lastModified;
      cmp = (aDate || '').localeCompare(bDate || '');
    } else if (field === 'size') cmp = a.size - b.size;
  }
  return dir === 'asc' ? cmp : -cmp;
}

function validateCompareTarget(a: string, b: string): string | null {
  if (b === a) return 'Pick a different folder';
  if (b !== '' && (a.startsWith(b) || b.startsWith(a))) {
    return 'Pick a folder outside the first one (no ancestor/descendant)';
  }
  return null;
}

function validateMergeTarget(src: string, dest: string): string | null {
  if (dest === src) return 'Pick a different folder';
  if (dest.startsWith(src)) return "Can't merge a folder into itself or a descendant";
  return null;
}

export default function BrowseScreen() {
  const colorScheme = useColorScheme() ?? 'light';
  const colors = Colors[colorScheme];
  const { showAlert } = useAlert();
  const navigation = useNavigation();
  const router = useRouter();
  const { contentPaddingBottom, aboveFabBottom } = useAiFabClearance();

  const { addJob } = useJobs();
  const [overflowVisible, setOverflowVisible] = useState(false);
  const [searchModalVisible, setSearchModalVisible] = useState(false);
  const [sortSheetVisible, setSortSheetVisible] = useState(false);
  const [filterSheetVisible, setFilterSheetVisible] = useState(false);
  const [renameError, setRenameError] = useState<string | null>(null);

  const [path, setPath] = useState('');

  // Mirror the current folder into SecureStore so the Assistant tab can default
  // its scope to wherever the user is browsing.
  useEffect(() => {
    setAssistantContextPrefix(path);
  }, [path]);

  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [previewIndex, setPreviewIndex] = useState<number | null>(null);

  const [nextToken, setNextToken] = useState<string | undefined>(undefined);
  const [loadingMore, setLoadingMore] = useState(false);

  const [selectionMode, setSelectionMode] = useState(false);
  const [selection, setSelection] = useState<Selection>(emptySelection);
  const [moveDestVisible, setMoveDestVisible] = useState(false);
  const [mergeDestVisible, setMergeDestVisible] = useState(false);
  const [mergeSource, setMergeSource] = useState<string | null>(null);
  const [comparePickerVisible, setComparePickerVisible] = useState(false);
  const [folderAForCompare, setFolderAForCompare] = useState<string | null>(null);
  const [renameVisible, setRenameVisible] = useState(false);
  const [renameInitialOverride, setRenameInitialOverride] = useState<string | null>(null);
  // When set, the next runRename treats the new name as the destination filename
  // inside this prefix instead of an in-place rename. Populated by collision
  // handlers in runMove so the user's original move intent is preserved.
  const [collisionMoveDest, setCollisionMoveDest] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  // Merge-policy modal: shown when a single-folder move collides with an
  // existing destination that has overlapping content.
  type MergePolicyModalState = {
    fromPrefix: string;
    toPrefix: string;
    report: CollisionReport;
  };
  const [mergePolicyModal, setMergePolicyModal] = useState<MergePolicyModalState | null>(null);
  // Resolve function for the currently-open merge modal. Settled when the user
  // picks a policy or cancels (null = cancelled).
  const mergePolicyResolveRef = useRef<((policy: MergePolicy | null) => void) | null>(null);

  function promptMergePolicy(fromPrefix: string, toPrefix: string, report: CollisionReport): Promise<MergePolicy | null> {
    return new Promise((resolve) => {
      mergePolicyResolveRef.current = resolve;
      setMergePolicyModal({ fromPrefix, toPrefix, report });
    });
  }

  const [snack, setSnack] = useState<{ message: string; onUndo: () => void } | null>(null);
  type Filter = 'all' | 'image' | 'video';
  const FILTER_LABELS: Record<Filter, string> = {
    all: 'All',
    image: 'Images',
    video: 'Videos',
  };

  const [filter, setFilter] = useState<Filter>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [sortField, setSortField] = useState<SortField>('name');
  const [sortDir, setSortDir] = useState<SortDir>('asc');
  const [viewMode, setViewMode] = useState<ViewMode>('grid');

  // Derived selection state — needs to live above useLayoutEffect so the
  // header closure can reference selectionActive without a temporal dead zone.
  const selectionCount = selection.files.size + selection.folders.size;
  const selectionActive = selectionMode || selectionCount > 0;
  const canCompare = selection.folders.size === 2 && selection.files.size === 0;
  const canMerge = selection.folders.size === 1 && selection.files.size === 0;

  useLayoutEffect(() => {
    navigation.setOptions({
      headerRight: () => (
        <View style={styles.headerActions}>
          <Pressable
            onPress={() => setViewMode((m) => (m === 'list' ? 'grid' : 'list'))}
            hitSlop={8}
            accessibilityLabel={`Switch to ${viewMode === 'list' ? 'grid' : 'list'} view`}>
            <IconSymbol
              name={viewMode === 'list' ? 'square.grid.2x2' : 'list.bullet'}
              size={22}
              color={colors.icon}
            />
          </Pressable>
          <Pressable
            onPress={() => setSearchModalVisible(true)}
            hitSlop={8}
            accessibilityLabel="Search">
            <IconSymbol name="magnifyingglass" size={22} color={colors.icon} />
          </Pressable>
          <Pressable
            onPress={() => setOverflowVisible(true)}
            hitSlop={8}
            accessibilityLabel="More options">
            <IconSymbol name="ellipsis" size={22} color={colors.icon} />
          </Pressable>
        </View>
      ),
    });
  }, [navigation, colors.icon, viewMode]);

  // Lazy-fetched thumbnail URLs for image rows that the server returned
  // without a previewUrl (i.e. the thumb hasn't been backfilled yet).
  // Map<key, url>. Keyed separately from row state so re-renders that
  // sort/filter rows don't reset the cache.
  const [thumbUrlCache, setThumbUrlCache] = useState<Map<string, string>>(new Map());

  const [folderPreviewCache, setFolderPreviewCache] = useState<Map<string, FolderPreviewState>>(new Map());
  // Tracks in-flight folder-preview requests so the viewability handler doesn't
  // fire duplicates for the same prefix before the first resolves.
  const folderPreviewInflight = useRef<Set<string>>(new Set());

  const trimmedQuery = searchQuery.trim().toLowerCase();
  const sortedRows = [...rows]
    .filter((r) => {
      if (filter !== 'all' && r.kind !== 'folder' && r.mediaKind !== filter) {
        return false;
      }
      if (trimmedQuery && !r.name.toLowerCase().includes(trimmedQuery)) {
        return false;
      }
      return true;
    })
    .sort((a, b) => compareRows(a, b, sortField, sortDir));

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

  function suggestRenameForCollision(name: string): string {
    // Split on last '.' to preserve extension, handling names like "photo.thumb.jpg"
    const dotIdx = name.lastIndexOf('.');
    const base = dotIdx > 0 ? name.slice(0, dotIdx) : name;
    const ext = dotIdx > 0 ? name.slice(dotIdx) : '';

    // If the base already ends with "(N)", increment the counter.
    const counterMatch = base.match(/^(.*)\((\d+)\)$/);
    if (counterMatch) {
      const prefix = counterMatch[1] ?? '';
      const n = parseInt(counterMatch[2] ?? '1', 10);
      return `${prefix}(${n + 1})${ext}`;
    }
    return `${base} (1)${ext}`;
  }

  async function runRename(newName: string) {
    setRenameVisible(false);
    setRenameError(null);
    if (!singleSelected) return;
    const trimmed = newName.trim();
    if (!trimmed || trimmed.includes('/')) {
      showAlert('Invalid name', 'Name cannot be empty or contain "/".');
      return;
    }

    // collisionMoveDest is set when this rename is the second step of a move
    // that hit a destination collision — we move into that prefix with the
    // new name instead of renaming in place. Snapshot now; clear in finally.
    const moveDestOverride = collisionMoveDest;
    const isCollisionMove = moveDestOverride !== null;
    const operationLabel = isCollisionMove ? 'Moving…' : 'Renaming…';

    if (singleSelected.kind === 'file') {
      setBusy(operationLabel);
      try {
        const dest = isCollisionMove
          ? moveDestOverride + trimmed
          : dirname(singleSelected.key) + trimmed;
        const res = await api.moveFile(singleSelected.key, dest);
        if (res.failed?.length) {
          for (const entry of res.failed) {
            await recordMoveFailure({ from: entry.key, to: dest, itemKind: 'file', reason: entry.reason }).catch(() => undefined);
          }
          showAlert(
            isCollisionMove ? 'Move partially completed' : 'Rename partially completed',
            `${res.failed.length} item(s) could not be ${isCollisionMove ? 'moved' : 'renamed'}:\n` +
              res.failed
                .slice(0, 5)
                .map((e: { key: string; reason: string }) => `• ${e.key}: ${e.reason}`)
                .join('\n'),
          );
        } else {
          await recordMoveSuccess({ from: singleSelected.key, to: dest, itemKind: 'file' }).catch(() => undefined);
        }
        setSelection(emptySelection());
        setSelectionMode(false);
        await load(path, 'refresh');
      } catch (err) {
        showAlert(
          isCollisionMove ? 'Move failed' : 'Rename failed',
          err instanceof Error ? err.message : 'Unknown error',
        );
      } finally {
        setBusy(null);
        setCollisionMoveDest(null);
      }
      return;
    }

    // Folder branch — async via SQS job. Clear the busy overlay the moment we
    // have a jobId so the user sees the JobsStrip take over instead of staring
    // at the centered card through the post-rename directory refresh.
    setBusy(operationLabel);
    try {
      const dest = isCollisionMove
        ? moveDestOverride + trimmed + '/'
        : dirname(singleSelected.prefix.replace(/\/$/, '')) + trimmed + '/';
      const fromPrefix = singleSelected.prefix;
      const res = await api.moveFolder(fromPrefix, dest);
      await addJob(res.jobId, { fromPrefix, toPrefix: dest });
      await recordMoveSuccess({ from: fromPrefix, to: dest, itemKind: 'folder' }).catch(() => undefined);
      setBusy(null);
      setSelection(emptySelection());
      setSelectionMode(false);
      await load(path, 'refresh');
    } catch (err) {
      if (isFolderTooLargeError(err)) {
        const body = err.body as FolderTooLargeErrorBody;
        const countStr = body.truncated ? `${body.fileCount}+` : String(body.fileCount);
        setRenameError(`Folder too large (${countStr} files; limit ${body.limit})`);
        setRenameVisible(true);
        setBusy(null);
        return;
      }
      showAlert(
        isCollisionMove ? 'Move failed' : 'Rename failed',
        err instanceof Error ? err.message : 'Unknown error',
      );
    } finally {
      setBusy(null);
      setCollisionMoveDest(null);
    }
  }

  const rowsFromResponse = useCallback((res: ListResponse): Row[] => {
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
      createdAt: f.createdAt,
      mediaKind: f.kind,
      previewUrl: f.previewUrl,
    }));
    return [...folderRows, ...fileRows];
  }, []);

  const load = useCallback(async (prefix: string, mode: 'fresh' | 'refresh' = 'fresh') => {
    const cfg = await loadConfig();
    if (!cfg) {
      setError('Not configured. Open the Settings tab and add your backend URL + token.');
      setRows([]);
      setNextToken(undefined);
      return;
    }
    if (mode === 'fresh') setLoading(true);
    setError(null);
    try {
      const res: ListResponse = await api.list({ prefix });
      setRows(rowsFromResponse(res));
      setNextToken(res.nextToken);
    } catch (err) {
      const message =
        err instanceof ApiError
          ? `(${err.status}) ${err.message}`
          : err instanceof Error
            ? err.message
            : 'Unknown error';
      setError(message);
      setRows([]);
      setNextToken(undefined);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  // Refetch whenever Browse comes into focus or the path changes. The focus
  // hook means coming back from the Gallery tab after an upload picks up the
  // newly-uploaded files without a manual pull-to-refresh.
  useFocusEffect(
    useCallback(() => {
      setNextToken(undefined);
      load(path);
      setSelection(emptySelection());
      setSelectionMode(false);
    }, [path, load]),
  );

  // Refresh when the Assistant tab has approved a create-folder or move action.
  // We track the mutation version in a ref so we only reload when it changes,
  // not on every focus (the existing useFocusEffect above already handles that).
  const mutationVersionRef = useRef<number>(-1);
  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      async function checkMutationVersion() {
        const v = await getAssistantMutationVersion();
        if (cancelled) return;
        if (mutationVersionRef.current === -1) {
          // First focus: record baseline without triggering an extra load.
          mutationVersionRef.current = v;
          return;
        }
        if (v !== mutationVersionRef.current) {
          mutationVersionRef.current = v;
          load(path, 'refresh');
        }
      }
      checkMutationVersion();
      return () => { cancelled = true; };
    }, [path, load]),
  );

  useEffect(() => { setSearchQuery(''); }, [path]);

  // Clear any rename override and inline error when user navigates or changes
  // selection so the modal doesn't open with stale state.
  useEffect(() => {
    setRenameInitialOverride(null);
    setRenameError(null);
  }, [path, selection]);

  // Clear per-folder caches when the path changes so stale entries from the
  // previous directory don't linger. A new load() call will populate fresh rows.
  useEffect(() => {
    setThumbUrlCache(new Map());
    setFolderPreviewCache(new Map());
    folderPreviewInflight.current.clear();
  }, [path]);

  // Lazy-fetch thumbnail URLs for image rows that came back from /list without
  // a previewUrl. Bounded to MAX_CONCURRENT in-flight so we don't fire 500
  // requests simultaneously in a large folder. Errors are logged once per key
  // and not retried — the user can pull-to-refresh if needed.
  const MAX_CONCURRENT = 4;
  useEffect(() => {
    const missing = rows.filter(
      (r): r is Extract<typeof r, { kind: 'file' }> =>
        r.kind === 'file' &&
        r.mediaKind === 'image' &&
        r.previewUrl === undefined &&
        !thumbUrlCache.has(r.key),
    );
    if (missing.length === 0) return;

    let cancelled = false;
    let inFlight = 0;
    let idx = 0;

    function next() {
      if (cancelled) return;
      while (inFlight < MAX_CONCURRENT && idx < missing.length) {
        const row = missing[idx++]!;
        inFlight += 1;
        api
          .getDerivedUrl(row.key, 'thumbnail')
          .then((res) => {
            if (cancelled) return;
            // res is GetDerivedUrlResponse | GetDerivedUrlError
            if ((res as { url: null | string }).url !== null) {
              const url = (res as GetDerivedUrlResponse).url;
              setThumbUrlCache((prev) => {
                if (prev.has(row.key)) return prev;
                const next = new Map(prev);
                next.set(row.key, url);
                return next;
              });
            }
          })
          .catch((err) => {
            console.warn('[Browse] getDerivedUrl failed for', row.key, err);
          })
          .finally(() => {
            inFlight -= 1;
            next();
          });
      }
    }

    next();
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows]);

  // Auto-dismiss the snackbar after 5s.
  useEffect(() => {
    if (!snack) return;
    const t = setTimeout(() => setSnack(null), 5000);
    return () => clearTimeout(t);
  }, [snack]);

  // Keep a ref that always holds the latest folderPreviewCache Map so the
  // stable viewability callback (below) can read current state without
  // being re-created on every render.
  const folderPreviewCacheRef = useRef<Map<string, FolderPreviewState>>(new Map());
  useEffect(() => { folderPreviewCacheRef.current = folderPreviewCache; }, [folderPreviewCache]);

  // Stable ref for the FlatList viewability handler — FlatList requires
  // onViewableItemsChanged to not change identity between renders.
  const onViewableFolders = useRef(
    ({ viewableItems }: { viewableItems: Array<{ item: Row }> }) => {
      for (const { item } of viewableItems) {
        if (item.kind !== 'folder') continue;
        const prefix = item.prefix;
        // Skip if already in-flight or already fetched (not idle/missing).
        const existing = folderPreviewCacheRef.current.get(prefix);
        if (
          folderPreviewInflight.current.has(prefix) ||
          (existing && existing.status !== 'idle')
        ) {
          continue;
        }
        folderPreviewInflight.current.add(prefix);
        setFolderPreviewCache((prev) => {
          const next = new Map(prev);
          next.set(prefix, { status: 'loading' });
          return next;
        });
        api
          .folderPreview(prefix)
          .then((res) => {
            setFolderPreviewCache((prev) => {
              const next = new Map(prev);
              next.set(prefix, {
                status: 'ready',
                thumbs: res.thumbs,
                hasContent: res.hasContent,
                counts: res.counts,
              });
              return next;
            });
          })
          .catch(() => {
            setFolderPreviewCache((prev) => {
              const next = new Map(prev);
              next.set(prefix, { status: 'error' });
              return next;
            });
          })
          .finally(() => {
            folderPreviewInflight.current.delete(prefix);
          });
      }
    },
  );

  const loadMore = useCallback(async () => {
    if (!nextToken || loadingMore) return;
    setLoadingMore(true);
    try {
      const res = await api.list({ prefix: path, continuationToken: nextToken });
      if (res.prefix !== path) return;
      setRows((prev) => [...prev, ...rowsFromResponse(res)]);
      setNextToken(res.nextToken);
    } catch (err) {
      // Don't disrupt the list on a paging error — let user pull-to-refresh.
      console.warn('loadMore failed', err);
    } finally {
      setLoadingMore(false);
    }
  }, [nextToken, loadingMore, path, rowsFromResponse]);

  function goUp() {
    if (path === '') return;
    const trimmed = path.replace(/\/$/, '');
    const idx = trimmed.lastIndexOf('/');
    setPath(idx === -1 ? '' : trimmed.slice(0, idx + 1));
  }

  useFocusEffect(
    useCallback(() => {
      const sub = BackHandler.addEventListener('hardwareBackPress', () => {
        if (selectionActive) {
          setSelection(emptySelection());
          setSelectionMode(false);
          return true;
        }
        if (path !== '') {
          goUp();
          return true;
        }
        return false;
      });
      return () => sub.remove();
    }, [path, selectionActive]),
  );

  function onRefresh() {
    setRefreshing(true);
    setThumbUrlCache(new Map());
    setFolderPreviewCache(new Map());
    folderPreviewInflight.current.clear();
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
    showAlert('Confirm delete', message, [
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
        showAlert(
          'Partial delete',
          `Deleted ${res.deleted.length} object(s). ${res.errors.length} failed:\n` +
            res.errors
              .slice(0, 5)
              .map((e) => `• ${e.key}: ${e.message}`)
              .join('\n'),
        );
      }
      setSelection(emptySelection());
      setSelectionMode(false);
      await load(path, 'refresh');
      if (res.deleted.length > 0) {
        const deleted = res.deleted;
        setSnack({
          message: `Deleted ${deleted.length} object(s)`,
          onUndo: () => undoDelete(deleted),
        });
      }
    } catch (err) {
      showAlert(
        'Delete failed',
        err instanceof Error ? err.message : 'Unknown error',
      );
    } finally {
      setBusy(null);
    }
  }

  async function undoDelete(keys: string[]) {
    setBusy(`Restoring ${keys.length} object(s)…`);
    try {
      const res = await api.restore(keys);
      if (res.missing.length > 0) {
        showAlert(
          'Partial restore',
          `Restored ${res.restored.length}. ${res.missing.length} couldn't be restored — the bucket may not have versioning enabled.`,
        );
      }
      await load(path, 'refresh');
    } catch (err) {
      showAlert(
        'Restore failed',
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
    let totalMoved = 0;
    // Accumulates per-item failures for the summary alert and Sync log.
    let failed: Array<{ src: string; message: string }> = [];
    const movedFiles: Array<{ from: string; to: string }> = [];
    const movedFolders: Array<{ from: string; to: string }> = [];

    for (const key of files) {
      const dest = destPrefix + basename(key);
      try {
        const res = await api.moveFile(key, dest);
        // Per-item failures inside a file move (the file itself failed to copy).
        if (res.failed?.length) {
          for (const entry of res.failed) {
            captureApiError(new Error(entry.reason));
            await recordMoveFailure({ from: entry.key, to: dest, itemKind: 'file', reason: entry.reason }).catch(() => undefined);
            failed.push({ src: entry.key, message: entry.reason });
          }
        } else {
          totalMoved += res.moved;
          movedFiles.push({ from: key, to: dest });
          await recordMoveSuccess({ from: key, to: dest, itemKind: 'file' }).catch(() => undefined);
        }
      } catch (err) {
        if (total === 1 && isUserActionableError(err)) {
          // Destination exists — user-actionable. Skip Sync log + Sentry; the alert carries the message.
          setBusy(null);
          const suggestion = suggestRenameForCollision(basename(key));
          showAlert('Destination already exists', err.message, [
            {
              text: 'Cancel',
              style: 'cancel',
              onPress: () => { setSelection(emptySelection()); setSelectionMode(false); },
            },
            {
              text: 'Rename and Move',
              onPress: () => {
                setRenameInitialOverride(suggestion);
                // Capture the original move destination so runRename moves the
                // item into destPrefix with the new name (rather than renaming
                // in place under the source's parent).
                setCollisionMoveDest(destPrefix);
                setRenameVisible(true);
              },
            },
          ]);
          return;
        }
        captureApiError(err);
        await recordMoveFailure({ from: key, to: dest, itemKind: 'file', ...fromErr(err) }).catch(() => undefined);
        failed.push({ src: key, message: err instanceof Error ? err.message : 'failed' });
      }
      done += 1;
      setBusy(`Moving ${done} of ${total}…`);
    }

    for (const prefix of folders) {
      const folderName = basename(prefix.replace(/\/$/, ''));
      const dest = destPrefix + folderName + '/';
      try {
        // moveFolder returns 202 { jobId } — register in JobsContext; no sync result.
        const res = await api.moveFolder(prefix, dest);
        await addJob(res.jobId, { fromPrefix: prefix, toPrefix: dest });
        movedFolders.push({ from: prefix, to: dest });
        await recordMoveSuccess({ from: prefix, to: dest, itemKind: 'folder' }).catch(() => undefined);
      } catch (err) {
        if (total === 1 && isUserActionableError(err)) {
          // Destination folder exists — offer rename-and-move only.
          // Intentional merges are now reached via the dedicated Merge action.
          setBusy(null);
          const suggestion = suggestRenameForCollision(folderName);
          showAlert('Destination already exists', err.message, [
            {
              text: 'Cancel',
              style: 'cancel',
              onPress: () => { setSelection(emptySelection()); setSelectionMode(false); },
            },
            {
              text: 'Rename and Move',
              onPress: () => {
                setRenameInitialOverride(suggestion);
                setCollisionMoveDest(destPrefix);
                setRenameVisible(true);
              },
            },
          ]);
          return;
        }
        captureApiError(err);
        await recordMoveFailure({ from: prefix, to: dest, itemKind: 'folder', ...fromErr(err) }).catch(() => undefined);
        failed.push({ src: prefix, message: err instanceof Error ? err.message : 'failed' });
      }
      done += 1;
      setBusy(`Moving ${done} of ${total}…`);
    }

    setBusy(null);
    setSelection(emptySelection());
    setSelectionMode(false);
    await load(path, 'refresh');

    if (failed.length > 0) {
      showAlert(
        'Partial move',
        `${totalMoved} file(s) moved, ${failed.length} failed:\n` +
          failed
            .slice(0, 5)
            .map((f) => `• ${f.src}: ${f.message}`)
            .join('\n'),
      );
    }

    const movedCount = movedFiles.length + movedFolders.length;
    if (movedCount > 0) {
      setSnack({
        message: `Moved ${movedCount} item(s)`,
        onUndo: () => undoMove(movedFiles, movedFolders),
      });
    }
  }

  async function undoMove(
    files: Array<{ from: string; to: string }>,
    folders: Array<{ from: string; to: string }>,
  ) {
    setBusy(`Reverting move…`);
    try {
      for (const f of files) {
        await api.moveFile(f.to, f.from);
      }
      for (const f of folders) {
        await api.moveFolder(f.to, f.from);
      }
      await load(path, 'refresh');
    } catch (err) {
      showAlert(
        'Undo move failed',
        err instanceof Error ? err.message : 'Unknown error',
      );
    } finally {
      setBusy(null);
    }
  }

  function onTapMerge() {
    const src = Array.from(selection.folders)[0];
    if (!src) return;
    setMergeSource(src);
    setMergeDestVisible(true);
  }

  async function runMerge(dest: string) {
    setMergeDestVisible(false);
    if (mergeSource == null) return;

    let report: CollisionReport;
    setBusy('Checking for conflicts…');
    try {
      report = await detectCollisions(mergeSource, dest);
    } catch {
      report = { total: 0, samples: [], truncated: false };
    }
    setBusy(null);

    const policy = await promptMergePolicy(mergeSource, dest, report);
    setMergePolicyModal(null);

    if (policy === null) {
      setSelection(emptySelection());
      setSelectionMode(false);
      setMergeSource(null);
      return;
    }

    setBusy('Merging…');
    try {
      const res = await api.mergeFolder(mergeSource, dest, policy);
      await addJob(res.jobId, { fromPrefix: mergeSource, toPrefix: dest, kind: 'merge', policy });
      await recordMergeFolderSuccess({ from: mergeSource, to: dest, policy }).catch(() => undefined);
    } catch (err) {
      captureApiError(err);
      await recordMoveFailure({ from: mergeSource, to: dest, itemKind: 'folder', ...fromErr(err) }).catch(() => undefined);
      showAlert('Merge failed', err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setBusy(null);
      setSelection(emptySelection());
      setSelectionMode(false);
      setMergeSource(null);
      await load(path, 'refresh');
    }
  }

  const segments = splitPathSegments(path);

  return (
    <ThemedView style={styles.container}>
      {selectionActive ? (
        <View style={[styles.selectionHeader, { backgroundColor: colors.surface }]}>
          <Pressable
            onPress={() => { setSelection(emptySelection()); setSelectionMode(false); }}
            accessibilityLabel="Exit selection mode"
            accessibilityRole="button"
            style={({ pressed }) => [styles.selectionHeaderIconButton, { opacity: pressed ? 0.6 : 1 }]}>
            <IconSymbol name="xmark" size={22} color={colors.icon} />
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
            onUp={goUp}
            accent={colors.tint}
            muted={colors.muted}
            background={colors.surface}
          />
          {rows.length > 0 && (filter !== 'all' || searchQuery !== '') && (
            <View style={[styles.toolbar, { backgroundColor: colors.background }]}>
              {filter !== 'all' && (
                <Pressable
                  onPress={() => setFilterSheetVisible(true)}
                  hitSlop={6}
                  accessibilityLabel={`Filter: ${FILTER_LABELS[filter]} (tap to change)`}
                  style={({ pressed }) => [
                    styles.searchChip,
                    { backgroundColor: colors.accentSoft, opacity: pressed ? 0.6 : 1 },
                  ]}>
                  <ThemedText style={[styles.sortChipText, { color: colors.tint }]}>
                    {FILTER_LABELS[filter]}
                  </ThemedText>
                  <Pressable
                    onPress={() => setFilter('all')}
                    hitSlop={8}
                    accessibilityLabel="Clear filter">
                    <IconSymbol name="xmark.circle.fill" size={16} color={colors.tint} />
                  </Pressable>
                </Pressable>
              )}
              {searchQuery !== '' && (
                <Pressable
                  onPress={() => setSearchModalVisible(true)}
                  hitSlop={6}
                  accessibilityLabel={`Search: "${searchQuery}" (tap to edit)`}
                  style={({ pressed }) => [
                    styles.searchChip,
                    { backgroundColor: colors.accentSoft, opacity: pressed ? 0.6 : 1 },
                  ]}>
                  <IconSymbol name="magnifyingglass" size={14} color={colors.tint} />
                  <ThemedText
                    style={[styles.sortChipText, { color: colors.tint }]}
                    numberOfLines={1}>
                    {searchQuery}
                  </ThemedText>
                  <Pressable
                    onPress={() => setSearchQuery('')}
                    hitSlop={8}
                    accessibilityLabel="Clear search">
                    <IconSymbol name="xmark.circle.fill" size={16} color={colors.tint} />
                  </Pressable>
                </Pressable>
              )}
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
          key={viewMode}
          data={sortedRows}
          keyExtractor={(item) => (item.kind === 'folder' ? `f:${item.prefix}` : `k:${item.key}`)}
          numColumns={viewMode === 'grid' ? GRID_COLUMNS : 1}
          {...(viewMode === 'grid'
            ? {
                contentContainerStyle: { padding: GRID_SPACING, paddingBottom: contentPaddingBottom },
                columnWrapperStyle: { gap: GRID_SPACING, marginBottom: GRID_SPACING },
              }
            : {
                contentContainerStyle: {
                  paddingHorizontal: Spacing.lg,
                  paddingTop: Spacing.md,
                  paddingBottom: contentPaddingBottom,
                },
                ItemSeparatorComponent: () => <View style={{ height: Spacing.sm }} />,
              })}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
          onEndReached={loadMore}
          onEndReachedThreshold={0.5}
          viewabilityConfig={FOLDER_VIEWABILITY_CONFIG}
          onViewableItemsChanged={onViewableFolders.current}
          ListEmptyComponent={
            <ThemedText style={styles.empty}>
              {rows.length > 0
                ? 'No matches for the current filter / search.'
                : 'This folder is empty.'}
            </ThemedText>
          }
          ListFooterComponent={
            loadingMore ? (
              <View style={{ paddingVertical: Spacing.lg }}>
                <ActivityIndicator />
              </View>
            ) : null
          }
          renderItem={({ item }) => {
            const selected = isSelected(item);
            // Merge lazily-fetched thumb URLs into the item so render
            // functions don't need to know about thumbUrlCache.
            const resolved: Row =
              item.kind === 'file' && !item.previewUrl && thumbUrlCache.has(item.key)
                ? { ...item, previewUrl: thumbUrlCache.get(item.key) }
                : item;
            const folderPreview = item.kind === 'folder' ? folderPreviewCache.get(item.prefix) : undefined;
            if (viewMode === 'grid') {
              return renderGridTile({
                item: resolved,
                selected,
                selectionActive,
                colors,
                onTap: () => onTapRow(item),
                onLongPress: () => onLongPressRow(item),
                folderPreview,
              });
            }
            return renderListRow({
              item: resolved,
              selected,
              selectionActive,
              colors,
              onTap: () => onTapRow(item),
              onLongPress: () => onLongPressRow(item),
              folderPreview,
            });
          }}
        />
      )}

      {selectionCount > 0 && (
        <SelectionActionBar
          statusLabel={`${selectionCount} selected`}
          actions={backupActions({
            singleSelected: singleSelected !== null,
            canMerge,
            canCompare,
            onRename: () => setRenameVisible(true),
            onMerge: onTapMerge,
            onMove: () => setMoveDestVisible(true),
            onCompare: () => {
              const [folderA, folderB] = [...selection.folders].sort();
              router.push({ pathname: '/compare', params: { a: folderA, b: folderB } });
            },
            onDelete: confirmDelete,
          })}
          onDismiss={() => {
            setSelection(emptySelection());
            setSelectionMode(false);
          }}
          dismissAccessibilityLabel="Exit selection mode"
        />
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
        isFolderSelectable={(p) => !Array.from(selection.folders).some((src) => p.startsWith(src))}
      />

      <FolderPicker
        visible={comparePickerVisible}
        initialPath={''}
        confirmLabel="Compare"
        hideNewFolder
        validatePick={(b) => folderAForCompare ? validateCompareTarget(folderAForCompare, b) : null}
        isFolderSelectable={(p) => folderAForCompare ? validateCompareTarget(folderAForCompare, p) === null : true}
        onClose={() => { setComparePickerVisible(false); setFolderAForCompare(null); }}
        onPick={(b) => {
          const a = folderAForCompare!;
          const [first, second] = [a, b].sort();
          setComparePickerVisible(false);
          setFolderAForCompare(null);
          router.push({ pathname: '/compare', params: { a: first, b: second } });
        }}
      />

      <FolderPicker
        visible={mergeDestVisible}
        initialPath={''}
        confirmLabel="Merge here"
        hideNewFolder
        validatePick={(p) => mergeSource ? validateMergeTarget(mergeSource, p) : null}
        isFolderSelectable={(p) => mergeSource ? validateMergeTarget(mergeSource, p) === null : true}
        onClose={() => { setMergeDestVisible(false); setMergeSource(null); }}
        onPick={runMerge}
      />

      <RenameModal
        visible={renameVisible}
        title={
          collisionMoveDest
            ? (singleSelected?.kind === 'folder' ? 'Rename and move folder' : 'Rename and move file')
            : (singleSelected?.kind === 'folder' ? 'Rename folder' : 'Rename file')
        }
        submitLabel={collisionMoveDest ? 'Rename and Move' : 'Rename'}
        initialValue={renameInitialOverride ?? renameInitial}
        originalValue={renameInitial}
        errorMessage={renameError ?? undefined}
        onCancel={() => {
          setRenameVisible(false);
          setRenameInitialOverride(null);
          setRenameError(null);
          setCollisionMoveDest(null);
        }}
        onSubmit={runRename}
      />

      {mergePolicyModal && (
        <MergePolicyModal
          visible
          mode="intentional"
          fromPrefix={mergePolicyModal.fromPrefix}
          toPrefix={mergePolicyModal.toPrefix}
          report={mergePolicyModal.report}
          onCancel={() => {
            const resolve = mergePolicyResolveRef.current;
            mergePolicyResolveRef.current = null;
            resolve?.(null);
          }}
          onChoose={(policy) => {
            const resolve = mergePolicyResolveRef.current;
            mergePolicyResolveRef.current = null;
            resolve?.(policy);
          }}
        />
      )}

      {busy && (
        <View style={styles.busyOverlay}>
          <ThemedView style={styles.busyCard}>
            <ActivityIndicator />
            <ThemedText>{busy}</ThemedText>
          </ThemedView>
        </View>
      )}

      {snack && !busy && (
        <View style={[styles.snackbar, { backgroundColor: colors.surfaceElevated, bottom: aboveFabBottom }]}>
          <ThemedText style={styles.snackbarText} numberOfLines={2}>
            {snack.message}
          </ThemedText>
          <Pressable
            onPress={() => {
              const action = snack.onUndo;
              setSnack(null);
              action();
            }}
            hitSlop={8}>
            <ThemedText style={{ color: colors.tint, fontWeight: '700' }}>
              Undo
            </ThemedText>
          </Pressable>
        </View>
      )}

      <ActionSheet
        visible={overflowVisible}
        onClose={() => setOverflowVisible(false)}
        items={[
          ...(selectionActive
            ? []
            : [{ label: 'Select', onPress: () => setSelectionMode(true) }]),
          ...(selection.folders.size === 1 && selection.files.size === 0
            ? [{ label: 'Compare against…', onPress: () => { setFolderAForCompare(Array.from(selection.folders)[0]!); setComparePickerVisible(true); } }]
            : []),
          {
            label: 'Sort',
            trailing: `${SORT_LABELS[sortField]} ${sortDir === 'asc' ? '↑' : '↓'}`,
            onPress: () => setSortSheetVisible(true),
          },
          {
            label: 'Filter',
            trailing: FILTER_LABELS[filter],
            onPress: () => setFilterSheetVisible(true),
          },
          { label: 'Find duplicates', onPress: () => router.push('/duplicates') },
        ]}
      />

      <BottomSheet
        visible={sortSheetVisible}
        onClose={() => setSortSheetVisible(false)}
        title="Sort by"
        items={(['name', 'date', 'size'] as SortField[]).flatMap((f) =>
          (['asc', 'desc'] as SortDir[]).map((d) => ({
            label: `${SORT_LABELS[f]} (${d === 'asc' ? 'ascending' : 'descending'})`,
            active: sortField === f && sortDir === d,
            onPress: () => {
              setSortField(f);
              setSortDir(d);
            },
          })),
        )}
      />

      <BottomSheet
        visible={filterSheetVisible}
        onClose={() => setFilterSheetVisible(false)}
        title="Filter"
        items={(['all', 'image', 'video'] as Filter[]).map((value) => ({
          label: FILTER_LABELS[value],
          active: filter === value,
          onPress: () => setFilter(value),
        }))}
      />

      <SearchModal
        visible={searchModalVisible}
        initialValue={searchQuery}
        onCancel={() => setSearchModalVisible(false)}
        onSubmit={(q) => {
          setSearchQuery(q);
          setSearchModalVisible(false);
        }}
      />
    </ThemedView>
  );
}

function Breadcrumb({
  segments,
  onTap,
  onUp,
  accent,
  muted,
  background,
}: {
  segments: string[];
  onTap: (segments: string[]) => void;
  onUp: () => void;
  accent: string;
  muted: string;
  background: string;
}) {
  const atRoot = segments.length === 0;
  return (
    <View style={[styles.breadcrumb, { backgroundColor: background }]}>
      <Pressable
        onPress={onUp}
        disabled={atRoot}
        hitSlop={8}
        accessibilityLabel="Up one folder"
        style={({ pressed }) => [
          styles.upButton,
          { opacity: atRoot ? 0.25 : pressed ? 0.5 : 1 },
        ]}>
        <IconSymbol name="chevron.left" size={22} color={accent} />
      </Pressable>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.breadcrumbInner}
        style={{ flex: 1 }}>
        <Pressable onPress={() => onTap([])} accessibilityRole="button">
          <ThemedText style={{ color: accent, fontWeight: atRoot ? '700' : '600' }}>
            root
          </ThemedText>
        </Pressable>
        {segments.map((seg, i) => {
          const upto = segments.slice(0, i + 1);
          const isLast = i === segments.length - 1;
          return (
            <View key={i} style={{ flexDirection: 'row', alignItems: 'center' }}>
              <ThemedText style={{ marginHorizontal: 6, color: muted }}>/</ThemedText>
              <Pressable onPress={() => onTap(upto)} accessibilityRole="button">
                <ThemedText style={{ color: accent, fontWeight: isLast ? '700' : '500' }}>
                  {seg}
                </ThemedText>
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

type FolderPreviewState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; thumbs: FolderPreviewThumb[]; hasContent: boolean; counts?: FolderCounts }
  | { status: 'error' };

type RowRenderProps = {
  item: Row;
  selected: boolean;
  selectionActive: boolean;
  colors: (typeof Colors)['light'];
  onTap: () => void;
  onLongPress: () => void;
  folderPreview?: FolderPreviewState;
};

/**
 * Shows recursive file counts beneath a folder's name in list view only.
 * Loading state shows a muted ellipsis placeholder. Hides entirely when
 * total===0 (empty folder) or when counts are not yet available.
 * Zero-count type groups are omitted so the strip stays compact.
 */
function FolderCountStrip({
  fp,
  colors,
}: {
  fp: FolderPreviewState | undefined;
  colors: (typeof Colors)['light'];
}) {
  if (fp?.status === 'loading' || fp === undefined) {
    return (
      <ThemedText style={[styles.rowMeta, { color: colors.muted }]}>···</ThemedText>
    );
  }
  if (fp.status !== 'ready' || !fp.counts) return null;
  const { counts } = fp;
  if (counts.total === 0) return null;

  const totalLabel = counts.truncated ? `${counts.total}+` : String(counts.total);

  return (
    <View style={styles.countStrip}>
      <ThemedText style={[styles.countTotal, { color: colors.muted }]}>
        {totalLabel}
      </ThemedText>
      {counts.images > 0 && (
        <View style={styles.countGroup}>
          <IconSymbol name="photo.on.rectangle" size={11} color={colors.muted} />
          <ThemedText style={[styles.countGroupLabel, { color: colors.muted }]}>
            {counts.images}
          </ThemedText>
        </View>
      )}
      {counts.videos > 0 && (
        <View style={styles.countGroup}>
          <IconSymbol name="video.fill" size={11} color={colors.muted} />
          <ThemedText style={[styles.countGroupLabel, { color: colors.muted }]}>
            {counts.videos}
          </ThemedText>
        </View>
      )}
      {counts.other > 0 && (
        <View style={styles.countGroup}>
          <IconSymbol name="doc" size={11} color={colors.muted} />
          <ThemedText style={[styles.countGroupLabel, { color: colors.muted }]}>
            {counts.other}
          </ThemedText>
        </View>
      )}
    </View>
  );
}

function renderListRow({
  item,
  selected,
  selectionActive,
  colors,
  onTap,
  onLongPress,
  folderPreview,
}: RowRenderProps) {
  const isFolder = item.kind === 'folder';
  const fp = folderPreview;
  return (
    <Pressable
      onPress={onTap}
      onLongPress={onLongPress}
      style={({ pressed }) => [
        styles.row,
        {
          backgroundColor: selected ? colors.accentSoft : colors.surface,
          opacity: pressed ? 0.7 : 1,
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
            <ThemedText lightColor="#fff" darkColor="#000" style={styles.checkboxMark}>
              ✓
            </ThemedText>
          )}
        </View>
      )}
      {isFolder ? (
        <FolderThumb
          prefix={item.prefix}
          size={THUMB_SIZE}
          thumbs={fp?.status === 'ready' ? fp.thumbs : []}
          loading={fp?.status === 'loading' || fp === undefined}
          name={item.name}
        />
      ) : item.previewUrl ? (
        <View style={styles.thumb}>
          <Thumb
            uri={item.previewUrl}
            width={THUMB_SIZE}
            height={THUMB_SIZE}
            recyclingKey={item.key}
            fallback={
              <View style={[{ position: 'absolute', top: 0, left: 0, width: THUMB_SIZE, height: THUMB_SIZE }, styles.thumbSlot]}>
                <IconSymbol name="photo.on.rectangle" size={28} color={colors.icon} />
              </View>
            }
          />
        </View>
      ) : item.mediaKind === 'video' ? (
        <View style={[styles.thumb, styles.videoThumb]}>
          <ThemedText lightColor="#fff" darkColor="#fff" style={styles.videoThumbText}>
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
        {item.kind === 'file' && (
          <ThemedText style={styles.rowMeta}>
            {formatBytes(item.size)} · {formatDate(item.lastModified)}
          </ThemedText>
        )}
        {isFolder && <FolderCountStrip fp={fp} colors={colors} />}
      </View>
      {!selectionActive && isFolder && (
        <IconSymbol name="chevron.right" size={18} color={colors.icon} />
      )}
    </Pressable>
  );
}

function renderGridTile({
  item,
  selected,
  selectionActive,
  colors,
  onTap,
  onLongPress,
  folderPreview,
}: RowRenderProps) {
  const isFolder = item.kind === 'folder';
  const fp = folderPreview;
  return (
    <Pressable
      onPress={onTap}
      onLongPress={onLongPress}
      style={({ pressed }) => [styles.gridTile, { opacity: pressed ? 0.7 : 1 }]}>
      {isFolder ? (
        <View style={[styles.gridTile, styles.gridFolderTile]}>
          <FolderThumb
            prefix={item.prefix}
            size={Math.round(GRID_TILE * 0.7)}
            thumbs={fp?.status === 'ready' ? fp.thumbs : []}
            loading={fp?.status === 'loading' || fp === undefined}
            name={item.name}
          />
          <ThemedText style={styles.gridLabel} numberOfLines={2}>
            {item.name}
          </ThemedText>
        </View>
      ) : item.previewUrl ? (
        <Thumb
          uri={item.previewUrl}
          width={GRID_TILE}
          height={GRID_TILE}
          borderRadius={Radius.lg}
          recyclingKey={item.key}
          fallback={
            <View style={[{ position: 'absolute', top: 0, left: 0, width: GRID_TILE, height: GRID_TILE }, styles.gridFolderTile]}>
              <IconSymbol name="photo.on.rectangle" size={40} color={colors.icon} />
            </View>
          }
        />
      ) : item.mediaKind === 'video' ? (
        <View style={[styles.gridTile, styles.videoThumb]}>
          <ThemedText lightColor="#fff" darkColor="#fff" style={{ fontSize: 32 }}>
            ▶
          </ThemedText>
        </View>
      ) : (
        <View style={[styles.gridTile, styles.gridFolderTile]}>
          <IconSymbol name="photo.on.rectangle" size={40} color={colors.icon} />
          <ThemedText style={styles.gridLabel} numberOfLines={2}>
            {item.name}
          </ThemedText>
        </View>
      )}
      {!isFolder && item.mediaKind === 'video' && (
        <View style={styles.videoBadge}>
          <ThemedText lightColor="#fff" darkColor="#fff" style={styles.videoBadgeText}>
            VIDEO
          </ThemedText>
        </View>
      )}
      {selected && (
        <View style={[styles.gridSelectOverlay, { borderColor: colors.tint }]}>
          <View style={[styles.gridCheck, { backgroundColor: colors.tint }]}>
            <ThemedText lightColor="#fff" darkColor="#000" style={styles.gridCheckMark}>
              ✓
            </ThemedText>
          </View>
        </View>
      )}
      {selectionActive && !selected && (
        <View
          style={[
            styles.gridCheck,
            { borderColor: '#fff', borderWidth: 1.5, backgroundColor: 'rgba(0,0,0,0.3)' },
          ]}
        />
      )}
    </Pressable>
  );
}

function backupActions({
  singleSelected,
  canMerge,
  canCompare,
  onRename,
  onMerge,
  onMove,
  onCompare,
  onDelete,
}: {
  singleSelected: boolean;
  canMerge: boolean;
  canCompare: boolean;
  onRename: () => void;
  onMerge: () => void;
  onMove: () => void;
  onCompare: () => void;
  onDelete: () => void;
}): SelectionAction[] {
  const actions: SelectionAction[] = [];
  if (singleSelected) {
    actions.push({
      key: 'rename',
      icon: 'pencil',
      accessibilityLabel: 'Rename',
      onPress: onRename,
    });
  }
  if (canMerge) {
    actions.push({
      key: 'merge',
      icon: 'arrow.triangle.merge',
      accessibilityLabel: 'Merge into folder',
      onPress: onMerge,
    });
  }
  actions.push({
    key: 'move',
    icon: 'tray.and.arrow.down',
    accessibilityLabel: 'Move to folder',
    onPress: onMove,
  });
  if (canCompare) {
    actions.push({
      key: 'compare',
      icon: 'rectangle.split.2x1',
      accessibilityLabel: 'Compare folders',
      onPress: onCompare,
    });
  }
  actions.push({
    key: 'delete',
    icon: 'trash',
    accessibilityLabel: 'Delete',
    onPress: onDelete,
    tone: 'danger',
  });
  return actions;
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12 },
  breadcrumb: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  breadcrumbInner: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingRight: Spacing.lg,
    paddingVertical: 10,
  },
  upButton: {
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  selectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.sm,
    paddingVertical: Spacing.sm,
    ...Shadow.cardElevated,
  },
  selectionHeaderIconButton: {
    width: 44,
    height: 44,
    borderRadius: Radius.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.md,
    borderRadius: Radius.lg,
    ...Shadow.card,
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
  rowLabel: { fontSize: 16, fontWeight: '500' },
  rowMeta: { fontSize: 12, opacity: 0.7, marginTop: 2 },
  countStrip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    marginTop: Spacing.xs,
  },
  countTotal: {
    fontSize: 11,
    fontWeight: '500',
  },
  countGroup: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
  },
  countGroupLabel: {
    fontSize: 11,
  },
  thumb: {
    width: THUMB_SIZE,
    height: THUMB_SIZE,
    borderRadius: Radius.md,
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
  toolbar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    paddingHorizontal: Spacing.lg,
    paddingTop: Spacing.sm,
    paddingBottom: Spacing.xs,
  },
  sortChip: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: Radius.md,
  },
  sortChipText: { fontSize: 13, fontWeight: '600' },
  searchChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.xs,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: Radius.md,
    maxWidth: 220,
  },
  headerActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.lg,
    paddingRight: Spacing.md,
  },
  gridTile: {
    width: GRID_TILE,
    height: GRID_TILE,
    borderRadius: Radius.lg,
    overflow: 'hidden',
    backgroundColor: 'rgba(0,0,0,0.05)',
  },
  gridFolderTile: {
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    padding: 8,
  },
  gridImage: { width: '100%', height: '100%' },
  gridLabel: {
    fontSize: 11,
    textAlign: 'center',
    paddingHorizontal: 4,
  },
  gridSelectOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    borderWidth: 3,
    borderRadius: Radius.lg,
  },
  gridCheck: {
    position: 'absolute',
    top: 6,
    right: 6,
    width: 22,
    height: 22,
    borderRadius: 11,
    alignItems: 'center',
    justifyContent: 'center',
  },
  gridCheckMark: { fontWeight: '700', fontSize: 14 },
  videoBadge: {
    position: 'absolute',
    bottom: 4,
    left: 4,
    backgroundColor: 'rgba(0,0,0,0.65)',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
  },
  videoBadgeText: { fontSize: 10, fontWeight: '700' },
  empty: { textAlign: 'center', opacity: 0.6, padding: 32 },
  retryButton: {
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderRadius: 8,
    borderWidth: 1,
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
  snackbar: {
    position: 'absolute',
    left: Spacing.lg,
    right: Spacing.lg,
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.md,
    borderRadius: Radius.md,
    ...Shadow.cardElevated,
  },
  snackbarText: { flex: 1, fontSize: 14 },
});
