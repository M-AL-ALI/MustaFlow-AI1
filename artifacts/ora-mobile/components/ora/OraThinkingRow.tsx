import React, { useEffect } from "react";
import { Text, View } from "react-native";
import Animated, {
  Easing,
  interpolate,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withRepeat,
  withTiming,
} from "react-native-reanimated";

import { useColors } from "@/hooks/useColors";
import { OraAtom } from "@/components/ora/OraAtom";

function ThinkingDot({ delay, color }: { delay: number; color: string }) {
  const pulse = useSharedValue(0);

  useEffect(() => {
    pulse.value = withDelay(
      delay,
      withRepeat(withTiming(1, { duration: 900, easing: Easing.inOut(Easing.ease) }), -1, true),
    );
  }, [delay, pulse]);

  const style = useAnimatedStyle(() => ({
    opacity: interpolate(pulse.value, [0, 1], [0.35, 1]),
    transform: [{ translateY: interpolate(pulse.value, [0, 1], [0, -2]) }],
  }));

  return (
    <Animated.View
      style={[
        {
          width: 5,
          height: 5,
          borderRadius: 3,
          backgroundColor: color,
        },
        style,
      ]}
    />
  );
}

export function OraThinkingRow({ accentColor }: { accentColor: string }) {
  const c = useColors();
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 10, paddingTop: 2 }}>
      <View style={{ marginTop: 2 }}>
        <OraAtom size={24} accentColor={accentColor} animated />
      </View>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
          <ThinkingDot delay={0} color={accentColor} />
          <ThinkingDot delay={140} color={accentColor} />
          <ThinkingDot delay={280} color={accentColor} />
        </View>
        <Text style={{ color: c.mutedForeground, fontSize: 11, fontFamily: "Inter_400Regular" }}>
          Thinking…
        </Text>
      </View>
    </View>
  );
}
