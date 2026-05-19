import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';

import { QrScannerModal } from '@/components/qr-scanner-modal';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { useAlert } from '@/components/ui/alert-provider';
import { Colors, Radius, Spacing, Type } from '@/constants/theme';
import { useColorScheme } from '@/hooks/use-color-scheme';
import { healthCheck } from '@/lib/api';
import { clearConfig, loadConfig, saveConfig } from '@/lib/config';
import { loadActivityCount } from '@/lib/activityLog';
import { parseQrPayload } from '@/lib/qr-config';

export default function SettingsScreen() {
  const colorScheme = useColorScheme() ?? 'light';
  const colors = Colors[colorScheme];
  const router = useRouter();
  const { showAlert } = useAlert();

  const [backendUrl, setBackendUrl] = useState('');
  const [bootstrapToken, setBootstrapToken] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [activityCount, setActivityCount] = useState(0);
  const [scannerVisible, setScannerVisible] = useState(false);

  useEffect(() => {
    loadConfig().then((cfg) => {
      if (cfg) {
        setBackendUrl(cfg.backendUrl);
        setBootstrapToken(cfg.bootstrapToken);
      }
      setLoading(false);
    });
  }, []);

  const refreshActivityCount = useCallback(() => {
    loadActivityCount().then(setActivityCount).catch(() => undefined);
  }, []);

  useEffect(() => {
    refreshActivityCount();
  }, [refreshActivityCount]);

  useFocusEffect(
    useCallback(() => {
      refreshActivityCount();
    }, [refreshActivityCount]),
  );

  async function onSave() {
    if (!backendUrl.trim() || !bootstrapToken.trim()) {
      showAlert('Missing fields', 'Both backend URL and bootstrap token are required.');
      return;
    }
    setBusy(true);
    try {
      await saveConfig({ backendUrl, bootstrapToken });
      showAlert('Saved', 'Settings stored securely on device.');
    } catch (err) {
      showAlert('Save failed', err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setBusy(false);
    }
  }

  async function onTest() {
    setBusy(true);
    try {
      const cfg = { backendUrl: backendUrl.trim().replace(/\/+$/, ''), bootstrapToken };
      const ok = await healthCheck(cfg);
      showAlert(
        ok ? 'Connected' : 'Reachable but unhealthy',
        ok
          ? 'Backend health check passed.'
          : 'Backend responded but /health returned non-2xx.',
      );
    } catch (err) {
      showAlert(
        'Connection failed',
        err instanceof Error ? err.message : 'Could not reach the backend.',
      );
    } finally {
      setBusy(false);
    }
  }

  function onClear() {
    showAlert(
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

  function onScanQr() {
    setScannerVisible(true);
  }

  async function applyQrConfig(raw: string) {
    setScannerVisible(false);

    const result = parseQrPayload(raw);
    if (!result.ok) {
      const messages: Record<typeof result.reason, string> = {
        'invalid-json': 'The scanned code did not contain valid JSON. Make sure you scanned the QR code printed by npm run qr.',
        'missing-fields': 'The scanned QR code is missing the apiUrl or bootstrapToken field.',
        'bad-url': 'The API URL in the QR code is not allowed. Must be https:// (production) or http:// to a local-network address (dev).',
      };
      showAlert('Invalid QR code', messages[result.reason]);
      return;
    }

    const doSave = async () => {
      setBusy(true);
      try {
        await saveConfig(result.config);
        setBackendUrl(result.config.backendUrl);
        setBootstrapToken(result.config.bootstrapToken);
        showAlert('Saved', 'Settings stored securely on device.');
      } catch (err) {
        showAlert('Save failed', err instanceof Error ? err.message : 'Unknown error');
      } finally {
        setBusy(false);
      }
    };

    const hasExisting = backendUrl.trim() || bootstrapToken.trim();
    if (hasExisting) {
      showAlert(
        'Replace existing config?',
        'This will overwrite the current API URL and bootstrap token.',
        [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Replace', style: 'destructive', onPress: doSave },
        ],
      );
    } else {
      await doSave();
    }
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
          <ThemedText style={[styles.hint, { color: colors.muted }]}>
            Paste the API URL and bootstrap token from your backend deploy, or scan the QR code
            printed by <ThemedText style={{ color: colors.text, fontWeight: '600' }}>npm run qr</ThemedText>.
          </ThemedText>

          <Pressable
            accessibilityRole="button"
            disabled={busy}
            onPress={onScanQr}
            style={({ pressed }) => [
              styles.scanButton,
              {
                backgroundColor: colors.accentSoft,
                borderColor: colors.tint,
                opacity: pressed || busy ? 0.7 : 1,
              },
            ]}>
            <Ionicons name="qr-code-outline" size={20} color={colors.tint} />
            <ThemedText style={[styles.scanButtonText, { color: colors.tint }]}>
              Scan QR
            </ThemedText>
          </Pressable>

          <View style={[styles.card, { backgroundColor: colors.surface }]}>
            <View style={styles.field}>
              <ThemedText style={styles.fieldLabel}>API URL</ThemedText>
              <TextInput
                value={backendUrl}
                onChangeText={setBackendUrl}
                placeholder="https://xxxxx.execute-api.region.amazonaws.com"
                placeholderTextColor={colors.muted}
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="url"
                style={[
                  styles.input,
                  { color: colors.text, backgroundColor: colors.surfaceMuted },
                ]}
              />
            </View>

            <View style={styles.field}>
              <ThemedText style={styles.fieldLabel}>Bootstrap token</ThemedText>
              <TextInput
                value={bootstrapToken}
                onChangeText={setBootstrapToken}
                placeholder="64-character hex string"
                placeholderTextColor={colors.muted}
                autoCapitalize="none"
                autoCorrect={false}
                secureTextEntry
                style={[
                  styles.input,
                  { color: colors.text, backgroundColor: colors.surfaceMuted },
                ]}
              />
            </View>
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
              <ThemedText style={[styles.buttonText, { color: colors.onAccent }]}>
                Save
              </ThemedText>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              disabled={busy || !backendUrl}
              onPress={onTest}
              style={({ pressed }) => [
                styles.button,
                { backgroundColor: colors.surfaceMuted, opacity: pressed || busy ? 0.7 : 1 },
              ]}>
              <ThemedText style={[styles.buttonText, { color: colors.tint }]}>Test</ThemedText>
            </Pressable>
          </View>

          <View style={[styles.card, { backgroundColor: colors.surface }]}>
            <Pressable
              accessibilityRole="button"
              onPress={() => router.push('/sync')}
              style={({ pressed }) => [styles.navRow, { opacity: pressed ? 0.7 : 1 }]}>
              <View style={styles.navRowLabel}>
                <ThemedText style={[Type.body, { color: colors.text }]}>Activity</ThemedText>
                {activityCount > 0 && (
                  <ThemedText style={[Type.label, { color: colors.muted }]}>
                    {' '}({activityCount})
                  </ThemedText>
                )}
              </View>
              <Ionicons name="chevron-forward" size={18} color={colors.muted} />
            </Pressable>
            <View style={[styles.navDivider, { backgroundColor: colors.divider }]} />
            <Pressable
              accessibilityRole="button"
              onPress={() => router.push('/duplicates')}
              style={({ pressed }) => [styles.navRow, { opacity: pressed ? 0.7 : 1 }]}>
              <ThemedText style={[Type.body, { color: colors.text }]}>Find duplicates</ThemedText>
              <Ionicons name="chevron-forward" size={18} color={colors.muted} />
            </Pressable>
            <View style={[styles.navDivider, { backgroundColor: colors.divider }]} />
            <Pressable
              accessibilityRole="button"
              onPress={() => router.push('/about')}
              style={({ pressed }) => [styles.navRow, { opacity: pressed ? 0.7 : 1 }]}>
              <ThemedText style={[Type.body, { color: colors.text }]}>About</ThemedText>
              <Ionicons name="chevron-forward" size={18} color={colors.muted} />
            </Pressable>
          </View>

          <Pressable
            accessibilityRole="button"
            onPress={onClear}
            style={styles.clearButton}>
            <ThemedText style={{ color: colors.danger, fontWeight: '500' }}>
              Clear stored settings
            </ThemedText>
          </Pressable>
        </ThemedView>
      </ScrollView>

      <QrScannerModal
        visible={scannerVisible}
        onClose={() => setScannerVisible(false)}
        onScanned={applyQrConfig}
      />
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: Spacing.lg, gap: Spacing.md },
  center: { alignItems: 'center', justifyContent: 'center' },
  scroll: { flexGrow: 1 },
  hint: { fontSize: 14, marginBottom: Spacing.xs, marginTop: Spacing.xs },
  card: {
    padding: Spacing.lg,
    borderRadius: Radius.lg,
    gap: Spacing.lg,
  },
  field: { gap: Spacing.xs },
  fieldLabel: { fontSize: 13, fontWeight: '600' },
  input: {
    borderRadius: Radius.md,
    paddingHorizontal: Spacing.md,
    paddingVertical: 12,
    fontSize: 16,
  },
  scanButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.sm,
    paddingVertical: 14,
    borderRadius: Radius.md,
    borderWidth: 1,
  },
  scanButtonText: { fontWeight: '600', fontSize: 15 },
  buttonRow: { flexDirection: 'row', gap: Spacing.md, marginTop: Spacing.xs },
  button: {
    flex: 1,
    paddingVertical: 14,
    borderRadius: Radius.md,
    alignItems: 'center',
  },
  buttonText: { fontWeight: '600', fontSize: 15 },
  clearButton: { marginTop: Spacing.xl, alignItems: 'center', paddingVertical: 8 },
  navRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  navRowLabel: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  navDivider: { height: 1 },
});
