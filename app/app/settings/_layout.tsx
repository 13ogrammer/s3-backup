import { Stack } from 'expo-router';

import { Colors } from '@/constants/theme';
import { useColorScheme } from '@/hooks/use-color-scheme';

export default function SettingsLayout() {
  const colorScheme = useColorScheme() ?? 'light';
  const colors = Colors[colorScheme];

  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: colors.background },
        headerTintColor: colors.text,
        headerShadowVisible: false,
      }}>
      <Stack.Screen name="index" options={{ title: 'Settings' }} />
      <Stack.Screen
        name="connection"
        options={{ title: 'Connection', headerBackTitle: 'Settings' }}
      />
      <Stack.Screen
        name="auto-backup"
        options={{ title: 'Auto-backup', headerBackTitle: 'Settings' }}
      />
      <Stack.Screen name="ai" options={{ title: 'AI', headerBackTitle: 'Settings' }} />
    </Stack>
  );
}
