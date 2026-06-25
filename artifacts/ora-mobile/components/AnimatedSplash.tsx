import { useEffect } from "react";
import { StyleSheet } from "react-native";
import Animated, {
  Easing,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withTiming,
} from "react-native-reanimated";

import { SplashAtom } from "@/components/SplashAtom";

// Matches app.json ios.splash backgroundColor so the JS overlay hands off
// seamlessly from the native launch image.
const BG = "#0a0a0a";

/**
 * AnimatedSplash — full-screen overlay shown right after the native splash hides.
 *
 * It mirrors the native launch screen (same dark background + centred Ora atom),
 * but the atom is the animated SplashAtom, so the startup logo now visibly moves.
 * After a short hold it fades out and calls `onFinish`, revealing the app.
 */
export function AnimatedSplash({ onFinish }: { onFinish: () => void }) {
  const overlayOpacity = useSharedValue(1);
  const atomOpacity = useSharedValue(0);
  const atomScale = useSharedValue(0.92);

  useEffect(() => {
    atomOpacity.value = withTiming(1, { duration: 450, easing: Easing.out(Easing.ease) });
    atomScale.value = withTiming(1, { duration: 650, easing: Easing.out(Easing.cubic) });
    overlayOpacity.value = withDelay(
      1500,
      withTiming(0, { duration: 450, easing: Easing.inOut(Easing.ease) }, (finished) => {
        if (finished) runOnJS(onFinish)();
      }),
    );
  }, [overlayOpacity, atomOpacity, atomScale, onFinish]);

  const overlayStyle = useAnimatedStyle(() => ({ opacity: overlayOpacity.value }));
  const atomStyle = useAnimatedStyle(() => ({
    opacity: atomOpacity.value,
    transform: [{ scale: atomScale.value }],
  }));

  return (
    <Animated.View
      style={[StyleSheet.absoluteFill, styles.container, overlayStyle]}
      pointerEvents="auto"
    >
      <Animated.View style={atomStyle}>
        <SplashAtom size={168} color="#10A37F" />
      </Animated.View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: BG,
    alignItems: "center",
    justifyContent: "center",
    zIndex: 999,
  },
});
