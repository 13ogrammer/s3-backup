import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Keyboard,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { IconSymbol } from '@/components/ui/icon-symbol';
import { Colors, Radius, Shadow, Spacing } from '@/constants/theme';
import { useColorScheme } from '@/hooks/use-color-scheme';
import { api } from '@/lib/api';

type Props = {
  visible: boolean;
  onClose: () => void;
  onPick: (prefix: string) => void;
  initialPath?: string;
  // S3B-55
  confirmLabel?: string;
  hideNewFolder?: boolean;
  validatePick?: (prefix: string) => string | null;
  // S3B-61: prevent tapping into folders that can't be valid targets (e.g. source folder in Compare)
  isFolderSelectable?: (prefix: string) => boolean;
};

export function FolderPicker({ visible, onClose, onPick, initialPath, confirmLabel, hideNewFolder, validatePick, isFolderSelectable }: Props) {
  const colorScheme = useColorScheme() ?? 'light';
  const colors = Colors[colorScheme];
  const insets = useSafeAreaInsets();

  const [path, setPath] = useState('');
  const [folders, setFolders] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [newName, setNewName] = useState('');
  const [keyboardHeight, setKeyboardHeight] = useState(0);

  useEffect(() => {
    const showEvent = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvent = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const show = Keyboard.addListener(showEvent, (e) => setKeyboardHeight(e.endCoordinates.height));
    const hide = Keyboard.addListener(hideEvent, () => setKeyboardHeight(0));
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);

  const load = useCallback(async (prefix: string) => {
    setLoading(true);
    try {
      const res = await api.list({ prefix });
      setFolders(res.folders);
    } catch (err) {
      Alert.alert(
        'Failed to list folders',
        err instanceof Error ? err.message : 'Unknown error',
      );
      setFolders([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (visible) {
      const start = initialPath ?? '';
      setPath(start);
      setNewName('');
      load(start);
    }
  }, [visible, initialPath, load]);

  function goInto(folderPrefix: string) {
    setPath(folderPrefix);
    load(folderPrefix);
  }

  function goUp() {
    if (path === '') return;
    const trimmed = path.replace(/\/$/, '');
    const idx = trimmed.lastIndexOf('/');
    const parent = idx === -1 ? '' : trimmed.slice(0, idx + 1);
    setPath(parent);
    load(parent);
  }

  const validationError = validatePick ? validatePick(path) : null;

  function pickHere() {
    if (validationError) return;
    onPick(path);
  }

  function createSubfolder() {
    const name = newName
      .trim()
      .replace(/^\/+|\/+$/g, '')
      .replace(/\/+/g, '/');
    if (!name) return;
    const next = path + name + '/';
    setPath(next);
    setNewName('');
    load(next);
  }

  const lastSegment = (folder: string): string => {
    const trimmed = folder.replace(/\/$/, '');
    const idx = trimmed.lastIndexOf('/');
    return idx === -1 ? trimmed : trimmed.slice(idx + 1);
  };

  return (
    <Modal
      visible={visible}
      animationType="slide"
      onRequestClose={onClose}
      statusBarTranslucent
      navigationBarTranslucent>
      <ThemedView style={[styles.container, { paddingBottom: keyboardHeight > 0 ? keyboardHeight + insets.bottom : 0 }]}>
        <View style={[styles.header, { paddingTop: insets.top + Spacing.md }]}>
          <Pressable onPress={onClose} accessibilityRole="button">
            <ThemedText style={{ color: colors.tint, fontSize: 16 }}>Cancel</ThemedText>
          </Pressable>
          <ThemedText type="defaultSemiBold">Choose folder</ThemedText>
          <Pressable onPress={pickHere} disabled={!!validationError} accessibilityRole="button">
            <ThemedText
              style={{
                color: colors.tint,
                fontWeight: '600',
                fontSize: 16,
                opacity: validationError ? 0.35 : 1,
              }}>
              {confirmLabel ?? 'Select'}
            </ThemedText>
          </Pressable>
        </View>
        {validationError && (
          <View style={[styles.errorBanner, { backgroundColor: colors.danger }]}>
            <ThemedText style={styles.errorText}>{validationError}</ThemedText>
          </View>
        )}

        <View style={[styles.breadcrumb, { backgroundColor: colors.surface }]}>
          {path !== '' && (
            <Pressable onPress={goUp} style={styles.upButton} accessibilityRole="button" hitSlop={8}>
              <IconSymbol name="chevron.left" size={20} color={colors.tint} />
              <ThemedText style={{ color: colors.tint, fontWeight: '500' }}>Up</ThemedText>
            </Pressable>
          )}
          <ThemedText style={[styles.pathText, { color: colors.muted }]} numberOfLines={1}>
            /{path || '(root)'}
          </ThemedText>
        </View>

        {loading ? (
          <View style={styles.center}>
            <ActivityIndicator />
          </View>
        ) : (
          <FlatList
            data={folders}
            keyExtractor={(item) => item}
            contentContainerStyle={styles.list}
            ItemSeparatorComponent={() => <View style={{ height: Spacing.sm }} />}
            ListEmptyComponent={
              <ThemedText style={[styles.empty, { color: colors.muted }]}>
                No subfolders. Use "New folder" below or tap Select to use this folder.
              </ThemedText>
            }
            renderItem={({ item }) => {
              const selectable = isFolderSelectable ? isFolderSelectable(item) : true;
              return (
                <Pressable
                  onPress={selectable ? () => goInto(item) : undefined}
                  disabled={!selectable}
                  accessibilityState={{ disabled: !selectable }}
                  style={({ pressed }) => [
                    styles.row,
                    { backgroundColor: colors.surface, opacity: !selectable ? 0.4 : pressed ? 0.7 : 1 },
                  ]}>
                  <IconSymbol name="folder" size={22} color={colors.icon} />
                  <ThemedText style={styles.rowLabel}>{lastSegment(item)}</ThemedText>
                  <IconSymbol name="chevron.right" size={18} color={colors.icon} />
                </Pressable>
              );
            }}
          />
        )}

        {!hideNewFolder && (
          <View
            style={[
              styles.newFolderRow,
              {
                backgroundColor: colors.surface,
                paddingBottom: keyboardHeight > 0 ? Spacing.md : Spacing.md + insets.bottom,
              },
            ]}>
            <TextInput
              value={newName}
              onChangeText={setNewName}
              placeholder="New folder name"
              placeholderTextColor={colors.muted}
              autoCapitalize="none"
              autoCorrect={false}
              style={[
                styles.input,
                { color: colors.text, backgroundColor: colors.surfaceMuted },
              ]}
              onSubmitEditing={createSubfolder}
              returnKeyType="done"
            />
            <Pressable
              onPress={createSubfolder}
              disabled={!newName.trim()}
              style={({ pressed }) => [
                styles.createButton,
                {
                  backgroundColor: colors.tint,
                  opacity: pressed || !newName.trim() ? 0.5 : 1,
                },
              ]}>
              <ThemedText style={[styles.createButtonText, { color: colors.onAccent }]}>
                Add
              </ThemedText>
            </Pressable>
          </View>
        )}
      </ThemedView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: Spacing.lg,
    paddingBottom: Spacing.md,
  },
  breadcrumb: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.md,
  },
  upButton: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  pathText: { flex: 1, fontSize: 14 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  empty: { textAlign: 'center', padding: Spacing.xl },
  list: { paddingHorizontal: Spacing.lg, paddingTop: Spacing.md, paddingBottom: Spacing.xl },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.md,
    borderRadius: Radius.lg,
    ...Shadow.card,
  },
  rowLabel: { flex: 1, fontSize: 16, fontWeight: '500' },
  newFolderRow: {
    flexDirection: 'row',
    gap: Spacing.sm,
    padding: Spacing.md,
    ...Shadow.cardElevated,
  },
  input: {
    flex: 1,
    borderRadius: Radius.md,
    paddingHorizontal: Spacing.md,
    paddingVertical: 12,
    fontSize: 16,
  },
  createButton: {
    paddingHorizontal: Spacing.lg,
    paddingVertical: 12,
    borderRadius: Radius.md,
    justifyContent: 'center',
  },
  createButtonText: { fontWeight: '600' },
  errorBanner: {
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.sm,
  },
  errorText: { color: '#fff', fontSize: 13, fontWeight: '500' },
});
