import { DarkTheme, DefaultTheme, ThemeProvider, type Theme } from '@react-navigation/native';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import 'react-native-reanimated';

import { BlockingUpdateModal, UpdateBanner } from '@/components/update-banner';
import { Colors } from '@/constants/theme';
import { useColorScheme } from '@/hooks/use-color-scheme';

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

  return (
    <ThemeProvider value={colorScheme === 'dark' ? DarkAppTheme : LightAppTheme}>
      <Stack>
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
      </Stack>
      <StatusBar style="auto" />
      <UpdateBanner />
      <BlockingUpdateModal />
    </ThemeProvider>
  );
}
