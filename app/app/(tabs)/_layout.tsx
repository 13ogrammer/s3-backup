import { Tabs } from 'expo-router';
import React from 'react';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { HapticTab } from '@/components/haptic-tab';
import { IconSymbol } from '@/components/ui/icon-symbol';
import { Colors, Spacing } from '@/constants/theme';
import { useColorScheme } from '@/hooks/use-color-scheme';

const TAB_BAR_CONTENT_HEIGHT = 48;
const TAB_ICON_SIZE = 22;

export default function TabLayout() {
  const colorScheme = useColorScheme();
  const insets = useSafeAreaInsets();

  const bottomPadding = Math.max(insets.bottom, Spacing.md);

  return (
    <Tabs
      screenOptions={{
        tabBarActiveTintColor: Colors[colorScheme ?? 'light'].tint,
        headerShown: true,
        tabBarButton: HapticTab,
        tabBarLabelStyle: { fontSize: 10, marginTop: -Spacing.xs },
        tabBarIconStyle: { marginTop: 0 },
        tabBarStyle: {
          height: TAB_BAR_CONTENT_HEIGHT + bottomPadding,
          paddingBottom: bottomPadding,
        },
      }}>
      <Tabs.Screen
        name="index"
        options={{
          title: 'Dashboard',
          headerShown: false,
          tabBarIcon: ({ color }) => <IconSymbol size={TAB_ICON_SIZE} name="house" color={color} />,
        }}
      />
      <Tabs.Screen
        name="gallery"
        options={{
          title: 'Gallery',
          tabBarIcon: ({ color }) => (
            <IconSymbol size={TAB_ICON_SIZE} name="photo.on.rectangle" color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="backup"
        options={{
          title: 'Backup',
          tabBarIcon: ({ color }) => <IconSymbol size={TAB_ICON_SIZE} name="icloud" color={color} />,
        }}
      />
      <Tabs.Screen
        name="assistant"
        options={{
          title: 'Assistant',
          tabBarIcon: ({ color }) => <IconSymbol size={TAB_ICON_SIZE} name="sparkles" color={color} />,
        }}
      />
      <Tabs.Screen
        name="settings"
        options={{
          title: 'Settings',
          tabBarIcon: ({ color }) => <IconSymbol size={TAB_ICON_SIZE} name="gearshape" color={color} />,
        }}
      />
    </Tabs>
  );
}
