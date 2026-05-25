import Constants from 'expo-constants';
import { Tabs, useRouter } from 'expo-router';
import React, { useState } from 'react';
import { Pressable } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { AiFab, TAB_BAR_CONTENT_HEIGHT } from '@/components/ai-fab';
import { AssistantSheet } from '@/components/assistant-sheet';
import { HapticTab } from '@/components/haptic-tab';
import { JobsStrip } from '@/components/jobs-strip';
import { IconSymbol } from '@/components/ui/icon-symbol';
import { Colors, Spacing } from '@/constants/theme';
import { useColorScheme } from '@/hooks/use-color-scheme';
const TAB_ICON_SIZE = 22;
const APP_NAME = Constants.expoConfig?.name ?? 'S3 Backup';

export default function TabLayout() {
  const colorScheme = useColorScheme() ?? 'light';
  const colors = Colors[colorScheme];
  const insets = useSafeAreaInsets();
  const router = useRouter();

  const [assistantOpen, setAssistantOpen] = useState(false);

  const bottomPadding = Math.max(insets.bottom, Spacing.md);

  return (
    <>
      <Tabs
      screenOptions={{
        tabBarActiveTintColor: colors.tint,
        headerShown: true,
        headerStyle: { backgroundColor: colors.background },
        headerTintColor: colors.text,
        headerShadowVisible: false,
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
          headerTitle: APP_NAME,
          headerRightContainerStyle: { paddingRight: Spacing.lg },
          headerRight: () => (
            <Pressable
              onPress={() => router.push('/settings')}
              hitSlop={8}
              accessibilityLabel="Settings">
              <IconSymbol size={22} name="gearshape" color={colors.icon} />
            </Pressable>
          ),
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
        name="activity"
        options={{
          title: 'Activity',
          tabBarIcon: ({ color }) => <IconSymbol size={TAB_ICON_SIZE} name="clock" color={color} />,
        }}
      />
    </Tabs>
      {/* Rendered AFTER Tabs so they paint on top — sibling z-order beats
       *  zIndex on Android. JobsStrip and AiFab carry their own absolute positioning. */}
      <JobsStrip />
      <AiFab onPress={() => setAssistantOpen(true)} />
      {/* Sheet stays mounted with visible prop — history + scroll preserved across opens */}
      <AssistantSheet visible={assistantOpen} onClose={() => setAssistantOpen(false)} />
    </>
  );
}
