import { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Colors } from '@/constants/theme';
import { useColorScheme } from '@/hooks/use-color-scheme';
import { healthCheck } from '@/lib/api';
import { clearConfig, loadConfig, saveConfig } from '@/lib/config';

export default function SettingsScreen() {
  const colorScheme = useColorScheme() ?? 'light';
  const colors = Colors[colorScheme];

  const [backendUrl, setBackendUrl] = useState('');
  const [bootstrapToken, setBootstrapToken] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    loadConfig().then((cfg) => {
      if (cfg) {
        setBackendUrl(cfg.backendUrl);
        setBootstrapToken(cfg.bootstrapToken);
      }
      setLoading(false);
    });
  }, []);

  async function onSave() {
    if (!backendUrl.trim() || !bootstrapToken.trim()) {
      Alert.alert('Missing fields', 'Both backend URL and bootstrap token are required.');
      return;
    }
    setBusy(true);
    try {
      await saveConfig({ backendUrl, bootstrapToken });
      Alert.alert('Saved', 'Settings stored securely on device.');
    } catch (err) {
      Alert.alert('Save failed', err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setBusy(false);
    }
  }

  async function onTest() {
    setBusy(true);
    try {
      const cfg = { backendUrl: backendUrl.trim().replace(/\/+$/, ''), bootstrapToken };
      const ok = await healthCheck(cfg);
      Alert.alert(
        ok ? 'Connected' : 'Reachable but unhealthy',
        ok
          ? 'Backend health check passed.'
          : 'Backend responded but /health returned non-2xx.',
      );
    } catch (err) {
      Alert.alert(
        'Connection failed',
        err instanceof Error ? err.message : 'Could not reach the backend.',
      );
    } finally {
      setBusy(false);
    }
  }

  function onClear() {
    Alert.alert(
      'Clear settings?',
      'This removes the backend URL and bootstrap token from this device.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Clear',
          style: 'destructive',
          onPress: async () => {
            await clearConfig();
            setBackendUrl('');
            setBootstrapToken('');
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

  return (
    <KeyboardAvoidingView
      style={{ flex: 1 }}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
        <ThemedView style={styles.container}>
          <ThemedText type="subtitle">Backend</ThemedText>
          <ThemedText style={styles.hint}>
            Paste the API URL and bootstrap token from your backend deploy.
          </ThemedText>

          <View style={styles.field}>
            <ThemedText type="defaultSemiBold">API URL</ThemedText>
            <TextInput
              value={backendUrl}
              onChangeText={setBackendUrl}
              placeholder="https://xxxxx.execute-api.region.amazonaws.com"
              placeholderTextColor={colors.icon}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
              style={[styles.input, { color: colors.text, borderColor: colors.icon }]}
            />
          </View>

          <View style={styles.field}>
            <ThemedText type="defaultSemiBold">Bootstrap token</ThemedText>
            <TextInput
              value={bootstrapToken}
              onChangeText={setBootstrapToken}
              placeholder="64-character hex string"
              placeholderTextColor={colors.icon}
              autoCapitalize="none"
              autoCorrect={false}
              secureTextEntry
              style={[styles.input, { color: colors.text, borderColor: colors.icon }]}
            />
          </View>

          <View style={styles.buttonRow}>
            <Pressable
              accessibilityRole="button"
              disabled={busy}
              onPress={onSave}
              style={({ pressed }) => [
                styles.button,
                { backgroundColor: colors.tint, opacity: pressed || busy ? 0.7 : 1 },
              ]}>
              <ThemedText style={styles.buttonText} lightColor="#fff" darkColor="#000">
                Save
              </ThemedText>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              disabled={busy || !backendUrl}
              onPress={onTest}
              style={({ pressed }) => [
                styles.button,
                styles.buttonSecondary,
                { borderColor: colors.tint, opacity: pressed || busy ? 0.7 : 1 },
              ]}>
              <ThemedText style={[styles.buttonText, { color: colors.tint }]}>Test</ThemedText>
            </Pressable>
          </View>

          <Pressable
            accessibilityRole="button"
            onPress={onClear}
            style={styles.clearButton}>
            <ThemedText style={{ color: '#c0392b' }}>Clear stored settings</ThemedText>
          </Pressable>
        </ThemedView>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 16, gap: 12 },
  center: { alignItems: 'center', justifyContent: 'center' },
  scroll: { flexGrow: 1 },
  hint: { opacity: 0.7 },
  field: { gap: 6 },
  input: {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 16,
  },
  buttonRow: { flexDirection: 'row', gap: 12, marginTop: 12 },
  button: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 8,
    alignItems: 'center',
  },
  buttonSecondary: { backgroundColor: 'transparent', borderWidth: 1 },
  buttonText: { fontWeight: '600' },
  clearButton: { marginTop: 24, alignItems: 'center', paddingVertical: 8 },
});
