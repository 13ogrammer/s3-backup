import { DarkTheme, DefaultTheme, ThemeProvider, type Theme } from '@react-navigation/native';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import 'react-native-reanimated';

import { AlertProvider } from '@/components/ui/alert-provider';
import { UpdateBanner } from '@/components/update-banner';
import { Colors } from '@/constants/theme';
import { useColorScheme } from '@/hooks/use-color-scheme';
import { initSentry } from '@/lib/sentry';
import { JobsProvider } from '@/lib/jobs';
// Side-effect import: registers the AUTO_BACKUP_TASK via TaskManager.defineTask
// at module load time — required before any BackgroundTask.registerTaskAsync call.
import '@/lib/autoBackupTask';
import { registerAutoBackup } from '@/lib/autoBackupTask';
import { loadAutoBackupState } from '@/lib/autoBackupState';

// Run once at bundle load — not inside RootLayout to avoid re-running on remount.
initSentry();

export const unstable_settings = {
  anchor: '(tabs)',
};

const buildTheme = (mode: 'light' | 'dark'): Theme => {
  const base = mode === 'dark' ? DarkTheme : DefaultTheme;
  const palette = Colors[mode];
  return {
    ...base,
    colors: {
      ...base.colors,
      primary: palette.tint,
      background: palette.background,
      card: palette.surface,
      text: palette.text,
      border: palette.divider,
      notification: palette.tint,
    },
  };
};

const LightAppTheme = buildTheme('light');
const DarkAppTheme = buildTheme('dark');

export default function RootLayout() {
  const colorScheme = useColorScheme();

  // On cold start: if auto-backup was enabled last session, re-register the
  // background task (it may have been unregistered by an OS upgrade or reinstall).
  useEffect(() => {
    loadAutoBackupState().then((s) => {
      if (s.enabled) registerAutoBackup().catch(console.warn);
    });
  }, []);

  return (
    <ThemeProvider value={colorScheme === 'dark' ? DarkAppTheme : LightAppTheme}>
      <JobsProvider>
        <AlertProvider>
          <Stack>
            <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
            <Stack.Screen name="settings" options={{ headerShown: false }} />
            <Stack.Screen name="about" options={{ title: 'About', headerBackTitle: 'Settings' }} />
            <Stack.Screen name="sync" options={{ title: 'Sync', headerBackTitle: 'Dashboard' }} />
            <Stack.Screen name="duplicates" options={{ title: 'Find duplicates', headerBackTitle: 'Settings' }} />
            <Stack.Screen name="compare" options={{ title: 'Compare folders', headerBackTitle: 'Browse' }} />
          </Stack>
        </AlertProvider>
        <StatusBar style="auto" />
        <UpdateBanner />
      </JobsProvider>
    </ThemeProvider>
  );
}
