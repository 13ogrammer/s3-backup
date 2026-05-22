import { useEffect, useRef } from 'react';
import { Animated, StyleSheet, View } from 'react-native';

type Props = {
  color: string;
  size?: number;
};

export function TypingDots({ color, size = 6 }: Props) {
  const a1 = useRef(new Animated.Value(0.3)).current;
  const a2 = useRef(new Animated.Value(0.3)).current;
  const a3 = useRef(new Animated.Value(0.3)).current;

  useEffect(() => {
    const make = (v: Animated.Value, delay: number) =>
      Animated.loop(
        Animated.sequence([
          Animated.delay(delay),
          Animated.timing(v, { toValue: 1, duration: 350, useNativeDriver: true }),
          Animated.timing(v, { toValue: 0.3, duration: 350, useNativeDriver: true }),
        ]),
      );
    const animations = [make(a1, 0), make(a2, 150), make(a3, 300)];
    animations.forEach((a) => a.start());
    return () => animations.forEach((a) => a.stop());
  }, [a1, a2, a3]);

  const dot = {
    width: size,
    height: size,
    borderRadius: size / 2,
    backgroundColor: color,
    marginHorizontal: size / 3,
  };

  return (
    <View style={styles.row}>
      <Animated.View style={[dot, { opacity: a1 }]} />
      <Animated.View style={[dot, { opacity: a2 }]} />
      <Animated.View style={[dot, { opacity: a3 }]} />
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
  },
});
