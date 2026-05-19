import { useEffect, useRef } from 'react';
import {
  ActivityIndicator,
  Alert,
  Animated,
  Platform,
  Pressable,
  StyleSheet,
  View,
} from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Colors, Radius, Spacing, Type } from '@/constants/theme';
import { useColorScheme } from '@/hooks/use-color-scheme';
import type { HeadResponse } from '@/lib/api';
import {
  basename,
  dirname,
  formatAperture,
  formatBytes,
  formatDateTaken,
  formatGps,
  formatShutter,
} from '@/lib/format';

export type HeadEntry =
  | { status: 'loading' }
  | { status: 'ok'; data: HeadResponse }
  | { status: 'unavailable' };

type Props = {
  fileKey: string;
  entry: HeadEntry | undefined;
  bottomInset: number;
};

export function MetadataPanel({ fileKey, entry, bottomInset }: Props) {
  const colorScheme = useColorScheme() ?? 'light';
  const colors = Colors[colorScheme];

  const toastOpacity = useRef(new Animated.Value(0)).current;

  // Reset toast when file changes.
  useEffect(() => {
    toastOpacity.setValue(0);
  }, [fileKey, toastOpacity]);

  function showCopyToast() {
    toastOpacity.setValue(1);
    Animated.timing(toastOpacity, {
      toValue: 0,
      duration: 300,
      delay: 1200,
      useNativeDriver: true,
    }).start();
  }

  function onGpsLongPress(coordString: string) {
    // expo-clipboard not available; fall back to Alert which surfaces the value.
    Alert.alert('GPS coordinates', coordString, [{ text: 'OK' }]);
    showCopyToast();
  }

  const panelBg = colorScheme === 'dark'
    ? 'rgba(13,17,27,0.92)'
    : 'rgba(248,250,252,0.94)';

  return (
    <View
      style={[
        styles.container,
        { backgroundColor: panelBg, paddingBottom: bottomInset + Spacing.lg },
      ]}>
      {/* Drag handle */}
      <View style={styles.handleRow}>
        <View style={[styles.handle, { backgroundColor: colors.border }]} />
      </View>

      {entry === undefined || entry.status === 'loading' ? (
        <View style={styles.loadingRow}>
          <ActivityIndicator color={colors.tint} />
        </View>
      ) : entry.status === 'unavailable' ? (
        <UnavailableBlock fileKey={fileKey} colors={colors} />
      ) : (
        <PopulatedBlock
          fileKey={fileKey}
          data={entry.data}
          colors={colors}
          onGpsLongPress={onGpsLongPress}
        />
      )}

      {/* Copy toast overlay */}
      <Animated.View
        style={[styles.toast, { opacity: toastOpacity, backgroundColor: colors.surface }]}
        pointerEvents="none">
        <ThemedText style={[Type.meta, { color: colors.text }]}>Copied</ThemedText>
      </Animated.View>
    </View>
  );
}

// ---- Always-available block shown when metadata is not present ----

function UnavailableBlock({
  fileKey,
  colors,
}: {
  fileKey: string;
  colors: (typeof Colors)['light'];
}) {
  return (
    <View style={styles.rows}>
      <MetaRow label="Filename" value={basename(fileKey)} colors={colors} />
      {dirname(fileKey) ? (
        <MetaRow label="Folder" value={dirname(fileKey)} colors={colors} />
      ) : null}
      <View style={[styles.divider, { backgroundColor: colors.divider }]} />
      <ThemedText style={[styles.unavailableNote, { color: colors.muted }]}>
        Metadata unavailable
      </ThemedText>
    </View>
  );
}

// ---- Populated block when /head returned metadata ----

function PopulatedBlock({
  fileKey,
  data,
  colors,
  onGpsLongPress,
}: {
  fileKey: string;
  data: HeadResponse;
  colors: (typeof Colors)['light'];
  onGpsLongPress: (coord: string) => void;
}) {
  const meta = data.metadata;
  const folder = dirname(fileKey);

  return (
    <View style={styles.rows}>
      {/* Always-available rows */}
      <MetaRow label="Filename" value={basename(fileKey)} colors={colors} />
      {folder ? <MetaRow label="Folder" value={folder} colors={colors} /> : null}
      <MetaRow label="Size" value={formatBytes(data.sizeBytes)} colors={colors} />
      <MetaRow
        label="Modified"
        value={formatDateTaken(data.lastModified)}
        colors={colors}
      />

      {/* Metadata rows — only rendered when the field is present */}
      {meta && (
        <>
          <View style={[styles.divider, { backgroundColor: colors.divider }]} />

          {meta.width && meta.height ? (
            <MetaRow
              label="Dimensions"
              value={`${meta.width} × ${meta.height}`}
              colors={colors}
            />
          ) : null}

          {meta.createdAt ? (
            <MetaRow
              label="Date taken"
              value={formatDateTaken(meta.createdAt)}
              colors={colors}
            />
          ) : null}

          {(meta.make || meta.model) ? (
            <MetaRow
              label="Camera"
              value={[meta.make, meta.model].filter(Boolean).join(' ')}
              colors={colors}
            />
          ) : null}

          {meta.lens ? (
            <MetaRow label="Lens" value={meta.lens} colors={colors} twoLine />
          ) : null}

          {meta.iso ? (
            <MetaRow label="ISO" value={meta.iso} colors={colors} />
          ) : null}

          {meta.aperture ? (
            <MetaRow
              label="Aperture"
              value={formatAperture(meta.aperture)}
              colors={colors}
            />
          ) : null}

          {meta.shutter ? (
            <MetaRow
              label="Shutter"
              value={formatShutter(meta.shutter)}
              colors={colors}
            />
          ) : null}

          {meta.lat && meta.lng ? (
            <GpsRow
              lat={meta.lat}
              lng={meta.lng}
              colors={colors}
              onLongPress={onGpsLongPress}
            />
          ) : null}
        </>
      )}
    </View>
  );
}

// ---- Row components ----

function MetaRow({
  label,
  value,
  colors,
  twoLine = false,
}: {
  label: string;
  value: string;
  colors: (typeof Colors)['light'];
  twoLine?: boolean;
}) {
  return (
    <View style={[styles.row, twoLine && styles.rowTwoLine]}>
      <ThemedText style={[styles.rowLabel, { color: colors.muted }]}>{label}</ThemedText>
      <ThemedText
        style={[styles.rowValue, { color: colors.text }, twoLine && styles.rowValueTwoLine]}
        numberOfLines={twoLine ? undefined : 1}>
        {value}
      </ThemedText>
    </View>
  );
}

function GpsRow({
  lat,
  lng,
  colors,
  onLongPress,
}: {
  lat: string;
  lng: string;
  colors: (typeof Colors)['light'];
  onLongPress: (coord: string) => void;
}) {
  const formatted = formatGps(lat, lng);
  return (
    <Pressable
      onLongPress={() => onLongPress(formatted)}
      accessibilityRole="text"
      accessibilityLabel={`GPS: ${formatted}. Long press to copy.`}
      accessibilityHint="Long press to copy coordinates"
      style={({ pressed }) => [styles.row, { opacity: pressed ? 0.6 : 1 }]}>
      <ThemedText style={[styles.rowLabel, { color: colors.muted }]}>GPS</ThemedText>
      <ThemedText style={[styles.rowValue, { color: colors.text }]} numberOfLines={1}>
        {formatted}
      </ThemedText>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: {
    borderTopLeftRadius: Radius.xl,
    borderTopRightRadius: Radius.xl,
    overflow: 'hidden',
    ...Platform.select({
      ios: {
        shadowColor: '#000',
        shadowOffset: { width: 0, height: -4 },
        shadowOpacity: 0.2,
        shadowRadius: 12,
      },
      android: { elevation: 8 },
    }),
  },
  handleRow: {
    alignItems: 'center',
    paddingTop: Spacing.sm,
    paddingBottom: Spacing.xs,
  },
  handle: {
    width: 36,
    height: 4,
    borderRadius: Radius.pill,
  },
  loadingRow: {
    paddingVertical: Spacing.xl,
    alignItems: 'center',
  },
  rows: {
    paddingHorizontal: Spacing.lg,
    paddingTop: Spacing.xs,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: Spacing.xs + 2,
    gap: Spacing.sm,
  },
  rowTwoLine: {
    alignItems: 'flex-start',
    flexDirection: 'column',
    gap: 2,
  },
  rowLabel: {
    ...Type.meta,
    minWidth: 80,
  },
  rowValue: {
    ...Type.label,
    flex: 1,
  },
  rowValueTwoLine: {
    flex: 0,
    flexShrink: 1,
  },
  divider: {
    height: StyleSheet.hairlineWidth,
    marginVertical: Spacing.sm,
  },
  unavailableNote: {
    ...Type.meta,
    paddingVertical: Spacing.sm,
    fontStyle: 'italic',
  },
  toast: {
    position: 'absolute',
    bottom: Spacing.xl,
    alignSelf: 'center',
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.sm,
    borderRadius: Radius.pill,
    ...Platform.select({
      ios: {
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.15,
        shadowRadius: 6,
      },
      android: { elevation: 4 },
    }),
  },
});
