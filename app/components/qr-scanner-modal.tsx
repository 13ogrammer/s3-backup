import { CameraView, useCameraPermissions } from 'expo-camera';
import type { BarcodeScanningResult } from 'expo-camera';
import { useEffect, useRef } from 'react';
import {
  Alert,
  Linking,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ThemedText } from '@/components/themed-text';
import { Colors, Radius, Spacing, Type } from '@/constants/theme';
import { useColorScheme } from '@/hooks/use-color-scheme';

export type QrScannerModalProps = {
  visible: boolean;
  onClose: () => void;
  /** Fires once with the raw decoded string. Parent is responsible for closing the modal. */
  onScanned: (raw: string) => void;
};

export function QrScannerModal({ visible, onClose, onScanned }: QrScannerModalProps) {
  const colorScheme = useColorScheme() ?? 'light';
  const colors = Colors[colorScheme];
  const insets = useSafeAreaInsets();

  const [permission, requestPermission] = useCameraPermissions();
  // Guard against firing onScanned more than once per open.
  const scannedRef = useRef(false);

  // Each time the modal opens, reset the scan-fired guard.
  useEffect(() => {
    if (visible) {
      scannedRef.current = false;
    }
  }, [visible]);

  // Request permission when the modal first becomes visible, provided we
  // haven't asked yet (permission is null = not determined).
  useEffect(() => {
    if (visible && permission !== null && !permission.granted && !permission.canAskAgain) {
      // Permission was previously denied and cannot be asked again — show
      // guidance to go to system Settings. We do this inside the effect so
      // the alert appears after the modal animation completes.
      Alert.alert(
        'Camera permission required',
        'Camera access was denied. To scan a QR code, enable camera permission for this app in your device Settings.',
        [
          {
            text: 'Open Settings',
            onPress: () => Linking.openSettings(),
          },
          { text: 'Cancel', style: 'cancel', onPress: onClose },
        ],
      );
    }
  }, [visible, permission, onClose]);

  function handleBarcodeScanned(result: BarcodeScanningResult) {
    if (scannedRef.current) return;
    scannedRef.current = true;
    onScanned(result.data);
  }

  async function handleRequestPermission() {
    const result = await requestPermission();
    if (!result.granted && !result.canAskAgain) {
      Alert.alert(
        'Camera permission required',
        'Camera access was denied. To scan a QR code, enable camera permission for this app in your device Settings.',
        [
          {
            text: 'Open Settings',
            onPress: () => Linking.openSettings(),
          },
          { text: 'Cancel', style: 'cancel' },
        ],
      );
    }
  }

  const showCamera = permission?.granted === true;
  const showPermissionPrompt = permission !== null && !permission.granted;

  return (
    <Modal
      visible={visible}
      animationType="slide"
      onRequestClose={onClose}
      transparent={false}
      statusBarTranslucent
      navigationBarTranslucent>
      <View style={[styles.container, { backgroundColor: '#000' }]}>
        {showCamera ? (
          <CameraView
            style={StyleSheet.absoluteFill}
            facing="back"
            barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
            onBarcodeScanned={handleBarcodeScanned}
          />
        ) : null}

        {/* Overlay chrome — top close button */}
        <View
          style={[
            styles.topBar,
            {
              paddingTop: insets.top + Spacing.sm,
              paddingHorizontal: Spacing.lg,
            },
          ]}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Close scanner"
            onPress={onClose}
            style={({ pressed }) => [
              styles.closeButton,
              { backgroundColor: colors.surface, opacity: pressed ? 0.7 : 1 },
            ]}>
            <ThemedText style={[Type.label, { color: colors.text }]}>Close</ThemedText>
          </Pressable>
        </View>

        {/* Viewfinder hint */}
        {showCamera ? (
          <View style={styles.viewfinderContainer}>
            <View
              style={[
                styles.viewfinder,
                { borderColor: colors.tint },
              ]}
            />
            <ThemedText
              style={[
                styles.hintText,
                { color: '#fff', marginTop: Spacing.lg },
              ]}>
              Point at the QR code from{'\n'}
              <ThemedText style={{ color: '#fff', fontWeight: '400' }}>
                npm run qr
              </ThemedText>
            </ThemedText>
          </View>
        ) : null}

        {/* Permission request prompt */}
        {showPermissionPrompt ? (
          <View
            style={[
              styles.permissionContainer,
              {
                paddingBottom: insets.bottom + Spacing.xl,
                paddingTop: insets.top + Spacing.xl,
                backgroundColor: colors.background,
              },
            ]}>
            <ThemedText style={[Type.section, { color: colors.text, textAlign: 'center' }]}>
              Camera access needed
            </ThemedText>
            <ThemedText
              style={[
                Type.body,
                { color: colors.muted, textAlign: 'center', marginTop: Spacing.md },
              ]}>
              Allow camera access to scan the QR code printed by{' '}
              <ThemedText style={{ color: colors.text, fontWeight: '600' }}>npm run qr</ThemedText>.
            </ThemedText>
            {permission?.canAskAgain ? (
              <Pressable
                accessibilityRole="button"
                onPress={handleRequestPermission}
                style={({ pressed }) => [
                  styles.permissionButton,
                  {
                    backgroundColor: colors.tint,
                    opacity: pressed ? 0.7 : 1,
                    marginTop: Spacing.xl,
                  },
                ]}>
                <ThemedText style={[Type.label, { color: colors.onAccent, fontWeight: '600' }]}>
                  Allow Camera
                </ThemedText>
              </Pressable>
            ) : (
              <Pressable
                accessibilityRole="button"
                onPress={() => {
                  if (Platform.OS !== 'web') Linking.openSettings();
                }}
                style={({ pressed }) => [
                  styles.permissionButton,
                  {
                    backgroundColor: colors.tint,
                    opacity: pressed ? 0.7 : 1,
                    marginTop: Spacing.xl,
                  },
                ]}>
                <ThemedText style={[Type.label, { color: colors.onAccent, fontWeight: '600' }]}>
                  Open Settings
                </ThemedText>
              </Pressable>
            )}
            <Pressable
              accessibilityRole="button"
              onPress={onClose}
              style={({ pressed }) => [styles.cancelButton, { opacity: pressed ? 0.6 : 1 }]}>
              <ThemedText style={[Type.label, { color: colors.muted }]}>Cancel</ThemedText>
            </Pressable>
          </View>
        ) : null}

        {/* Bottom safe-area spacer for Android nav bar */}
        {showCamera ? (
          <View style={{ height: insets.bottom }} />
        ) : null}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  topBar: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    flexDirection: 'row',
    justifyContent: 'flex-end',
    zIndex: 10,
  },
  closeButton: {
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm,
    borderRadius: Radius.pill,
  },
  viewfinderContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  viewfinder: {
    width: 220,
    height: 220,
    borderWidth: 3,
    borderRadius: Radius.lg,
  },
  hintText: {
    fontSize: 14,
    fontWeight: '600',
    textAlign: 'center',
  },
  permissionContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: Spacing.xl,
    gap: Spacing.sm,
  },
  permissionButton: {
    paddingVertical: 14,
    paddingHorizontal: Spacing.xl,
    borderRadius: Radius.md,
    alignItems: 'center',
    minWidth: 180,
  },
  cancelButton: {
    marginTop: Spacing.md,
    paddingVertical: 8,
    alignItems: 'center',
  },
});
