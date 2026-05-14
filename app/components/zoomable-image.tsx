import { Image } from 'expo-image';
import { useMemo, useState } from 'react';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';

const MIN_SCALE = 1;
const MAX_SCALE = 5;
const DOUBLE_TAP_SCALE = 2.5;
const ZOOMED_EPSILON = 1.01;

type Props = {
  uri: string;
  // Fired when the image crosses the zoomed / not-zoomed threshold so the
  // parent can disable its horizontal pager (otherwise a pan while zoomed
  // also flips pages).
  onZoomChange?: (zoomed: boolean) => void;
};

export function ZoomableImage({ uri, onZoomChange }: Props) {
  const scale = useSharedValue(1);
  const savedScale = useSharedValue(1);
  const translateX = useSharedValue(0);
  const translateY = useSharedValue(0);
  const savedTx = useSharedValue(0);
  const savedTy = useSharedValue(0);

  // Track zoom state on the JS thread so the Pan gesture can be enabled /
  // disabled — gesture-handler reads `.enabled()` once at construction.
  const [isZoomed, setIsZoomed] = useState(false);

  function reportZoom(zoomed: boolean) {
    setIsZoomed(zoomed);
    onZoomChange?.(zoomed);
  }

  function resetTranslation() {
    translateX.value = withTiming(0);
    translateY.value = withTiming(0);
    savedTx.value = 0;
    savedTy.value = 0;
  }

  const pinch = useMemo(
    () =>
      Gesture.Pinch()
        .onUpdate((e) => {
          'worklet';
          const next = savedScale.value * e.scale;
          scale.value = Math.min(MAX_SCALE, Math.max(MIN_SCALE, next));
        })
        .onEnd(() => {
          'worklet';
          savedScale.value = scale.value;
          const zoomed = scale.value > ZOOMED_EPSILON;
          if (!zoomed) {
            translateX.value = withTiming(0);
            translateY.value = withTiming(0);
            savedTx.value = 0;
            savedTy.value = 0;
          }
          runOnJS(reportZoom)(zoomed);
        }),
    [],
  );

  const doubleTap = useMemo(
    () =>
      Gesture.Tap()
        .numberOfTaps(2)
        .onEnd(() => {
          'worklet';
          const next = scale.value > ZOOMED_EPSILON ? 1 : DOUBLE_TAP_SCALE;
          scale.value = withTiming(next);
          savedScale.value = next;
          if (next === 1) {
            translateX.value = withTiming(0);
            translateY.value = withTiming(0);
            savedTx.value = 0;
            savedTy.value = 0;
          }
          runOnJS(reportZoom)(next > ZOOMED_EPSILON);
        }),
    [],
  );

  // Pan is only enabled while zoomed in. While unzoomed it stays disabled
  // so the parent horizontal pager keeps handling swipes.
  const pan = useMemo(
    () =>
      Gesture.Pan()
        .enabled(isZoomed)
        .onUpdate((e) => {
          'worklet';
          translateX.value = savedTx.value + e.translationX;
          translateY.value = savedTy.value + e.translationY;
        })
        .onEnd(() => {
          'worklet';
          savedTx.value = translateX.value;
          savedTy.value = translateY.value;
        }),
    [isZoomed],
  );

  const composed = Gesture.Race(doubleTap, Gesture.Simultaneous(pinch, pan));

  const style = useAnimatedStyle(() => ({
    transform: [
      { translateX: translateX.value },
      { translateY: translateY.value },
      { scale: scale.value },
    ],
  }));

  return (
    <GestureDetector gesture={composed}>
      <Animated.View style={[{ flex: 1, width: '100%' }, style]}>
        <Image
          source={{ uri }}
          style={{ flex: 1, width: '100%' }}
          contentFit="contain"
          transition={150}
        />
      </Animated.View>
    </GestureDetector>
  );
}
