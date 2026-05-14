import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Modal,
  Pressable,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { IconSymbol } from '@/components/ui/icon-symbol';
import { Colors } from '@/constants/theme';
import { useColorScheme } from '@/hooks/use-color-scheme';
import { api } from '@/lib/api';

type Props = {
  visible: boolean;
  onClose: () => void;
  onPick: (prefix: string) => void;
};

export function FolderPicker({ visible, onClose, onPick }: Props) {
  const colorScheme = useColorScheme() ?? 'light';
  const colors = Colors[colorScheme];

  const [path, setPath] = useState('');
  const [folders, setFolders] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [newName, setNewName] = useState('');

  const load = useCallback(async (prefix: string) => {
    setLoading(true);
    try {
      const res = await api.list(prefix);
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
      setPath('');
      setNewName('');
      load('');
    }
  }, [visible, load]);

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

  function pickHere() {
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
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <ThemedView style={styles.container}>
        <View style={styles.header}>
          <Pressable onPress={onClose} accessibilityRole="button">
            <ThemedText style={{ color: colors.tint, fontSize: 16 }}>Cancel</ThemedText>
          </Pressable>
          <ThemedText type="defaultSemiBold">Choose folder</ThemedText>
          <Pressable onPress={pickHere} accessibilityRole="button">
            <ThemedText style={{ color: colors.tint, fontWeight: '600', fontSize: 16 }}>
              Pick
            </ThemedText>
          </Pressable>
        </View>

        <View style={[styles.breadcrumb, { borderColor: colors.icon }]}>
          {path !== '' && (
            <Pressable onPress={goUp} style={styles.upButton} accessibilityRole="button">
              <IconSymbol name="chevron.right" size={20} color={colors.tint} />
              <ThemedText style={{ color: colors.tint }}>Up</ThemedText>
            </Pressable>
          )}
          <ThemedText style={styles.pathText} numberOfLines={1}>
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
            ListEmptyComponent={
              <ThemedText style={styles.empty}>No subfolders. Use "New folder" or pick here.</ThemedText>
            }
            renderItem={({ item }) => (
              <Pressable
                onPress={() => goInto(item)}
                style={({ pressed }) => [
                  styles.row,
                  { borderColor: colors.icon, opacity: pressed ? 0.6 : 1 },
                ]}>
                <IconSymbol name="folder" size={22} color={colors.icon} />
                <ThemedText style={styles.rowLabel}>{lastSegment(item)}</ThemedText>
              </Pressable>
            )}
          />
        )}

        <View style={[styles.newFolderRow, { borderColor: colors.icon }]}>
          <TextInput
            value={newName}
            onChangeText={setNewName}
            placeholder="New folder name"
            placeholderTextColor={colors.icon}
            autoCapitalize="none"
            autoCorrect={false}
            style={[styles.input, { color: colors.text, borderColor: colors.icon }]}
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
            <ThemedText lightColor="#fff" darkColor="#000" style={styles.createButtonText}>
              Add
            </ThemedText>
          </Pressable>
        </View>
      </ThemedView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, paddingTop: 60 },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingBottom: 12,
  },
  breadcrumb: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  upButton: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  pathText: { flex: 1, opacity: 0.75 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  empty: { textAlign: 'center', opacity: 0.6, padding: 32 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  rowLabel: { flex: 1, fontSize: 16 },
  newFolderRow: {
    flexDirection: 'row',
    gap: 8,
    padding: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  input: {
    flex: 1,
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 16,
  },
  createButton: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 8,
    justifyContent: 'center',
  },
  createButtonText: { fontWeight: '600' },
});
