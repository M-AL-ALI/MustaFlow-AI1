import { useEffect } from "react";
import { View, Text } from "react-native";
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withRepeat,
  withTiming,
} from "react-native-reanimated";
import { OraAtom } from "@/components/ora/OraAtom";
import { useColors } from "@/hooks/useColors";

/**
 * OraThinkingRow — native mirror of the website Ora loading indicator
 * (artifacts/mustaflow/src/components/ora-panel.tsx, the `isLoading &&
 * !isStreamingWithContent` block).
 *
 * The website does NOT render a blank assistant bubble while waiting for the
 * first token. Instead it shows a separate left-aligned row: the atom avatar,
 * three pulsing accent dots (staggered 0/200/400ms, accent at 50% alpha), and an
 * optional status label ("Thinking…", "Replying…", etc.).
 */
function ThinkingDot({ accentColor, delay }: { accentColor: string; delay: number }) {
  const opacity = useSharedValue(0.3);

  useEffect(() => {
    opacity.value = withDelay(
      delay,
      withRepeat(withTiming(1, { duration: 600, easing: Easing.inOut(Easing.ease) }), -1, true),
    );
  }, [delay, opacity]);

  const style = useAnimatedStyle(() => ({ opacity: opacity.value }));

  return (
    <Animated.View
      style={[{ width: 6, height: 6, borderRadius: 3, backgroundColor: accentColor + "80" }, style]}
    />
  );
}

export function OraThinkingRow({ accentColor, label }: { accentColor: string; label?: string }) {
  const c = useColors();

  return (
    <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 10 }}>
      <OraAtom size={24} accentColor={accentColor} style={{ marginTop: 2 }} />
      <View style={{ gap: 4, paddingTop: 2 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
          <ThinkingDot accentColor={accentColor} delay={0} />
          <ThinkingDot accentColor={accentColor} delay={200} />
          <ThinkingDot accentColor={accentColor} delay={400} />
        </View>
        {!!label && (
          <Text style={{ color: c.mutedForeground, fontSize: 11, fontFamily: "Inter_500Medium" }}>
            {label}
          </Text>
        )}
      </View>
    </View>
  );
}
