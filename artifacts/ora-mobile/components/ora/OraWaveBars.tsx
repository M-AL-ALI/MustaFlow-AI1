import React, { useEffect, useRef } from "react";
import { Animated, Easing, View } from "react-native";

/**
 * OraWaveBars — native mirror of the website's `WaveformBars`
 * (artifacts/mustaflow/src/components/ora/ora-voice-mode-button.tsx).
 *
 * Seven thin bars that animate (height bounce) while `animated`, used in the
 * Talk-to-Ora live card status row. Static (mid-height) when idle. `OraLiveDot`
 * mirrors the web "recording" red dot (a slow opacity pulse).
 */

// Mirrors the web BAR_DEFS (min/max heights in px, per-bar duration in ms).
const BAR_DEFS: { min: number; max: number; dur: number }[] = [
  { min: 2, max: 5, dur: 650 },
  { min: 3, max: 9, dur: 550 },
  { min: 4, max: 11, dur: 700 },
  { min: 2, max: 7, dur: 600 },
  { min: 5, max: 10, dur: 500 },
  { min: 3, max: 6, dur: 720 },
  { min: 2, max: 8, dur: 580 },
];

export function OraWaveBars({
  animated = false,
  color = "#ffffff",
  scale = 1,
}: {
  animated?: boolean;
  color?: string;
  scale?: number;
}) {
  const valuesRef = useRef(BAR_DEFS.map(() => new Animated.Value(0)));

  useEffect(() => {
    const values = valuesRef.current;
    if (!animated) {
      values.forEach((v) => v.stopAnimation(() => v.setValue(0)));
      return;
    }
    const loops = values.map((v, i) =>
      Animated.loop(
        Animated.sequence([
          Animated.timing(v, {
            toValue: 1,
            duration: BAR_DEFS[i].dur,
            delay: i * 65,
            easing: Easing.inOut(Easing.ease),
            useNativeDriver: false,
          }),
          Animated.timing(v, {
            toValue: 0,
            duration: BAR_DEFS[i].dur,
            easing: Easing.inOut(Easing.ease),
            useNativeDriver: false,
          }),
        ]),
      ),
    );
    loops.forEach((l) => l.start());
    return () => loops.forEach((l) => l.stop());
  }, [animated]);

  return (
    <View style={{ flexDirection: "row", alignItems: "flex-end", gap: 2 }}>
      {BAR_DEFS.map((b, i) => {
        const hMin = Math.max(1, Math.round(b.min * scale));
        const hMax = Math.round(b.max * scale);
        const v = valuesRef.current[i];
        return (
          <Animated.View
            key={i}
            style={{
              width: 2,
              borderRadius: 1,
              backgroundColor: color,
              height: animated
                ? v.interpolate({ inputRange: [0, 1], outputRange: [hMin, hMax] })
                : Math.round((hMin + hMax) / 2),
            }}
          />
        );
      })}
    </View>
  );
}

export function OraLiveDot({ color = "#f87171", size = 8 }: { color?: string; size?: number }) {
  const pulse = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, {
          toValue: 0.35,
          duration: 700,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
        Animated.timing(pulse, {
          toValue: 1,
          duration: 700,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [pulse]);

  return (
    <Animated.View
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        backgroundColor: color,
        opacity: pulse,
      }}
    />
  );
}
