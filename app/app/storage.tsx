import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  RefreshControl,
  ScrollView,
  StyleSheet,
  View,
} from 'react-native';

import { PreviewModal, type PreviewFile } from '@/components/preview-modal';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Colors, Radius, Spacing, Type } from '@/constants/theme';
import { useColorScheme } from '@/hooks/use-color-scheme';
import { api, type StorageStats } from '@/lib/api';
import { formatBytes, detectMediaType } from '@/lib/format';

export default function StorageScreen() {
  const colorScheme = useColorScheme() ?? 'light';
  const colors = Colors[colorScheme];

  const [stats, setStats] = useState<StorageStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [previewFiles, setPreviewFiles] = useState<PreviewFile[]>([]);
  const [previewIndex, setPreviewIndex] = useState<number | null>(null);

  const load = useCallback(async (forceRefresh = false) => {
    try {
      const result = await api.stats(forceRefresh ? { refresh: true } : {});
      setStats(result);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load storage stats');
    }
  }, []);

  useEffect(() => {
    setLoading(true);
    load().finally(() => setLoading(false));
  }, [load]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load(true);
    setRefreshing(false);
  }, [load]);

  function openPreview(key: string) {
    const kind = detectMediaType(key);
    if (kind === 'other') return;
    setPreviewFiles([{ key, kind }]);
    setPreviewIndex(0);
  }

  if (loading) {
    return (
      <ThemedView style={[styles.container, styles.center]}>
        <ActivityIndicator />
        <ThemedText style={[Type.body, { color: colors.muted, marginTop: Spacing.md }]}>
          Walking bucket…
        </ThemedText>
      </ThemedView>
    );
  }

  if (error) {
    return (
      <ThemedView style={[styles.container, styles.center]}>
        <ThemedText style={[Type.body, { color: colors.danger, textAlign: 'center' }]}>
          {error}
        </ThemedText>
      </ThemedView>
    );
  }

  if (!stats) return null;

  const totalType = stats.byType.photos.bytes + stats.byType.videos.bytes + stats.byType.other.bytes;

  return (
    <>
      <ScrollView
        style={{ flex: 1, backgroundColor: colors.background }}
        contentContainerStyle={styles.scroll}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={colors.tint}
          />
        }>

        {/* Headline */}
        <View style={[styles.card, { backgroundColor: colors.surface }]}>
          <ThemedText style={[Type.largeTitle, { color: colors.text }]}>
            {formatBytes(stats.totalBytes)}
          </ThemedText>
          <ThemedText style={[Type.body, { color: colors.muted }]}>
            {stats.totalCount.toLocaleString()} file{stats.totalCount !== 1 ? 's' : ''}
          </ThemedText>
          <View style={styles.costRow}>
            <ThemedText style={[Type.label, { color: colors.text }]}>
              Est. monthly cost
            </ThemedText>
            <ThemedText style={[Type.bodyStrong, { color: colors.tint }]}>
              ${stats.estimatedMonthlyUsd.toFixed(2)} / mo
            </ThemedText>
          </View>
          {stats.cached && (
            <ThemedText style={[Type.meta, { color: colors.muted }]}>
              Cached — pull down to refresh live data
            </ThemedText>
          )}
        </View>

        {/* Growth chart */}
        <View style={[styles.card, { backgroundColor: colors.surface }]}>
          <ThemedText style={[Type.section, { color: colors.text }]}>Growth (30 days)</ThemedText>
          {stats.growth.length === 0 ? (
            <ThemedText style={[Type.body, { color: colors.muted }]}>
              No CloudWatch data yet. Growth data is available for real AWS buckets after ~24 hours.
            </ThemedText>
          ) : (
            <GrowthChart data={stats.growth} barColor={colors.tint} mutedColor={colors.muted} />
          )}
        </View>

        {/* Type breakdown */}
        <View style={[styles.card, { backgroundColor: colors.surface }]}>
          <ThemedText style={[Type.section, { color: colors.text }]}>By type</ThemedText>
          <TypeRow
            label="Photos"
            bytes={stats.byType.photos.bytes}
            count={stats.byType.photos.count}
            total={totalType}
            barColor={colors.tint}
            colors={colors}
          />
          <TypeRow
            label="Videos"
            bytes={stats.byType.videos.bytes}
            count={stats.byType.videos.count}
            total={totalType}
            barColor={colors.videoBar}
            colors={colors}
          />
          <TypeRow
            label="Other"
            bytes={stats.byType.other.bytes}
            count={stats.byType.other.count}
            total={totalType}
            barColor={colors.muted}
            colors={colors}
          />
        </View>

        {/* Top folders */}
        {stats.topFolders.length > 0 && (
          <View style={[styles.card, { backgroundColor: colors.surface }]}>
            <ThemedText style={[Type.section, { color: colors.text }]}>Top folders</ThemedText>
            {stats.topFolders.map((f) => (
              <View key={f.prefix} style={styles.folderRow}>
                <ThemedText
                  style={[Type.label, { color: colors.text, flex: 1 }]}
                  numberOfLines={1}>
                  {f.prefix}
                </ThemedText>
                <ThemedText style={[Type.label, { color: colors.muted }]}>
                  {formatBytes(f.bytes)}
                </ThemedText>
              </View>
            ))}
          </View>
        )}

        {/* Very large files (>=1 GB) */}
        {stats.veryLargeFiles.length > 0 && (
          <View style={[styles.card, { backgroundColor: colors.surface }]}>
            <ThemedText style={[Type.section, { color: colors.text }]}>
              Very large files (≥ 1 GB)
            </ThemedText>
            {stats.veryLargeFiles.map((f) => (
              <LargeFileRow
                key={f.key}
                item={f}
                colors={colors}
                onPress={openPreview}
              />
            ))}
          </View>
        )}

        {/* Large files (>=500 MB — includes files also shown in the >=1 GB section above) */}
        {stats.largeFiles.length > 0 && (
          <View style={[styles.card, { backgroundColor: colors.surface }]}>
            <ThemedText style={[Type.section, { color: colors.text }]}>
              Large files (≥ 500 MB)
            </ThemedText>
            {stats.largeFiles.map((f) => (
              <LargeFileRow
                key={f.key}
                item={f}
                colors={colors}
                onPress={openPreview}
              />
            ))}
          </View>
        )}

      </ScrollView>

      <PreviewModal
        visible={previewIndex !== null}
        files={previewFiles}
        initialIndex={previewIndex}
        onClose={() => setPreviewIndex(null)}
      />
    </>
  );
}

// ---- Sub-components --------------------------------------------------------

type GrowthChartProps = {
  data: Array<{ date: string; bytes: number; count: number }>;
  barColor: string;
  mutedColor: string;
};

function GrowthChart({ data, barColor, mutedColor }: GrowthChartProps) {
  const maxBytes = Math.max(...data.map((d) => d.bytes), 1);
  // Show only first/last date labels to avoid crowding.
  const firstDate = data[0]?.date ?? '';
  const lastDate = data[data.length - 1]?.date ?? '';

  return (
    <View>
      <View style={styles.chartBars}>
        {data.map((d) => {
          const heightPct = (d.bytes / maxBytes) * 100;
          return (
            <View key={d.date} style={styles.barWrapper}>
              <View style={[styles.barFill, { height: `${Math.max(heightPct, 2)}%`, backgroundColor: barColor }]} />
            </View>
          );
        })}
      </View>
      <View style={styles.chartLabels}>
        <ThemedText style={[Type.meta, { color: mutedColor }]}>{firstDate}</ThemedText>
        <ThemedText style={[Type.meta, { color: mutedColor }]}>
          {formatBytes(data[data.length - 1]?.bytes ?? 0)}
        </ThemedText>
        <ThemedText style={[Type.meta, { color: mutedColor }]}>{lastDate}</ThemedText>
      </View>
    </View>
  );
}

type TypeRowProps = {
  label: string;
  bytes: number;
  count: number;
  total: number;
  barColor: string;
  colors: typeof Colors['light'];
};

function TypeRow({ label, bytes, count, total, barColor, colors }: TypeRowProps) {
  const pct = total > 0 ? bytes / total : 0;
  return (
    <View style={styles.typeRow}>
      <View style={styles.typeRowHeader}>
        <ThemedText style={[Type.label, { color: colors.text }]}>{label}</ThemedText>
        <ThemedText style={[Type.label, { color: colors.muted }]}>
          {formatBytes(bytes)} · {count.toLocaleString()}
        </ThemedText>
      </View>
      <View style={[styles.typeBarTrack, { backgroundColor: colors.surfaceMuted }]}>
        <View
          style={[
            styles.typeBarFill,
            { width: `${Math.round(pct * 100)}%`, backgroundColor: barColor },
          ]}
        />
      </View>
    </View>
  );
}

type LargeFileItem = { key: string; sizeBytes: number; lastModified: string };

type LargeFileRowProps = {
  item: LargeFileItem;
  colors: typeof Colors['light'];
  onPress: (key: string) => void;
};

function LargeFileRow({ item, colors, onPress }: LargeFileRowProps) {
  const kind = detectMediaType(item.key);
  const isInteractive = kind !== 'other';
  const filename = item.key.includes('/')
    ? item.key.slice(item.key.lastIndexOf('/') + 1)
    : item.key;

  if (!isInteractive) {
    return (
      <View style={styles.fileRow}>
        <View style={{ flex: 1 }}>
          <ThemedText
            style={[Type.label, { color: colors.text }]}
            numberOfLines={1}>
            {filename}
          </ThemedText>
          <ThemedText style={[Type.meta, { color: colors.muted }]}>
            {formatBytes(item.sizeBytes)} · no preview
          </ThemedText>
        </View>
      </View>
    );
  }

  return (
    <View
      style={styles.fileRow}
      accessible
      accessibilityRole="button"
      accessibilityLabel={`Preview ${filename}`}>
      <View
        style={{ flex: 1 }}
        onStartShouldSetResponder={() => true}
        onResponderRelease={() => onPress(item.key)}>
        <ThemedText
          style={[Type.label, { color: colors.tint }]}
          numberOfLines={1}>
          {filename}
        </ThemedText>
        <ThemedText style={[Type.meta, { color: colors.muted }]}>
          {formatBytes(item.sizeBytes)}
        </ThemedText>
      </View>
    </View>
  );
}

// ---- Styles ----------------------------------------------------------------

const styles = StyleSheet.create({
  container: { flex: 1 },
  center: { alignItems: 'center', justifyContent: 'center', padding: Spacing.xl },
  scroll: { padding: Spacing.lg, gap: Spacing.md, paddingBottom: Spacing.xxl },
  card: {
    borderRadius: Radius.lg,
    padding: Spacing.lg,
    gap: Spacing.md,
  },
  costRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: Spacing.xs,
  },
  chartBars: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    height: 80,
    gap: 2,
  },
  barWrapper: {
    flex: 1,
    height: '100%',
    justifyContent: 'flex-end',
  },
  barFill: {
    borderRadius: 2,
    minHeight: 2,
  },
  chartLabels: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: Spacing.xs,
  },
  typeRow: { gap: Spacing.xs },
  typeRowHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  typeBarTrack: {
    height: 8,
    borderRadius: Radius.pill,
    overflow: 'hidden',
  },
  typeBarFill: {
    height: '100%',
    borderRadius: Radius.pill,
    minWidth: 4,
  },
  folderRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: Spacing.md,
  },
  fileRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    paddingVertical: Spacing.xs,
  },
});
