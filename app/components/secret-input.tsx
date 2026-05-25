import { Ionicons } from '@expo/vector-icons';
import { useState } from 'react';
import { Pressable, StyleSheet, TextInput, type TextInputProps, View } from 'react-native';

export type SecretInputProps = {
  value: string;
  onChangeText: (v: string) => void;
  placeholder: string;
  placeholderTextColor: string;
  inputStyle: TextInputProps['style'];
  iconColor: string;
};

export function SecretInput({
  value,
  onChangeText,
  placeholder,
  placeholderTextColor,
  inputStyle,
  iconColor,
}: SecretInputProps) {
  const [visible, setVisible] = useState(false);
  return (
    <View style={styles.secretWrapper}>
      <TextInput
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={placeholderTextColor}
        autoCapitalize="none"
        autoCorrect={false}
        secureTextEntry={!visible}
        style={[inputStyle, styles.secretInput]}
      />
      <Pressable
        onPress={() => setVisible((v) => !v)}
        hitSlop={8}
        accessibilityRole="button"
        accessibilityLabel={visible ? 'Hide value' : 'Show value'}
        style={({ pressed }) => [styles.secretToggle, { opacity: pressed ? 0.6 : 1 }]}>
        <Ionicons
          name={visible ? 'eye-off-outline' : 'eye-outline'}
          size={20}
          color={iconColor}
        />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  secretWrapper: { position: 'relative' },
  secretInput: { paddingRight: 44 },
  secretToggle: {
    position: 'absolute',
    right: 4,
    top: 0,
    bottom: 0,
    width: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
