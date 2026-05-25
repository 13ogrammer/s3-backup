import { useNavigation } from 'expo-router';

import { AssistantSheet } from '@/components/assistant-sheet';

export default function AssistantScreen() {
  const navigation = useNavigation();

  return (
    <AssistantSheet
      visible
      onClose={() => {
        if (navigation.canGoBack()) navigation.goBack();
      }}
    />
  );
}
