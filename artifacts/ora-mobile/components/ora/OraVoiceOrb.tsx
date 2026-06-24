import { LinearGradient } from "expo-linear-gradient";
import { MicOff } from "lucide-react-native";
import React, { useEffect, useRef } from "react";
import { Animated, Easing, Pressable, View } from "react-native";

/**
 * OraVoiceOrb — native mirror of the website's `OraVoiceModeButton`
 * (artifacts/mustaflow/src/components/ora/ora-voice-mode-button.tsx).
 *
 * A circular gradient orb shown in the Ora header. Pressing it enters/exits
 * Talk-to-Ora voice conversation mode. The parent owns the talk state and maps
 * it onto these props:
 *   - `active`    → Talk mode is on (talkMode)
 *   - `listening` → mic is recording (recording)
 *   - `speaking`  → Ora's reply is being spoken (speakingId != null)
 *
 * Visuals mirror the web orb: a purple→blue gradient core, seven white waveform
 * bars that animate while active, a red ping ring + red border while listening,
 * and a soft glow while speaking.
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

export function OraVoiceOrb({
  active,
  listening = false,
  speaking = false,
  supported = true,
  disabled = false,
  onPress,
  size = "md",
}: {
  active: boolean;
  listening?: boolean;
  speaking?: boolean;
  supported?: boolean;
  disabled?: boolean;
  onPress: () => void;
  size?: "sm" | "md";
}) {
  const dim = size === "sm" ? 24 : 28;
  const scale = size === "sm" ? 0.75 : 1;
  const isInert = !supported;
  const isAnimating = active || listening || speaking;

  // One Animated.Value per waveform bar (0 → min height, 1 → max height).
  const valuesRef = useRef(BAR_DEFS.map(() => new Animated.Value(0)));
  useEffect(() => {
    const values = valuesRef.current;
    if (!isAnimating) {
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
  }, [isAnimating]);

  // Listening ping ring (scale + fade, native driver).
  const ping = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!listening) {
      ping.stopAnimation(() => ping.setValue(0));
      return;
    }
    const loop = Animated.loop(
      Animated.timing(ping, {
        toValue: 1,
        duration: 1300,
        easing: Easing.out(Easing.ease),
        useNativeDriver: true,
      }),
    );
    loop.start();
    return () => loop.stop();
  }, [listening, ping]);

  return (
    <Pressable
      onPress={() => {
        if (isInert || disabled) return;
        onPress();
      }}
      disabled={isInert || disabled}
      hitSlop={8}
      accessibilityRole="button"
      accessibilityState={{ selected: active, disabled: isInert || disabled }}
      accessibilityLabel={
        listening
          ? "Ora is listening — tap to end voice mode"
          : speaking
            ? "Ora is speaking — tap to end voice mode"
            : active
              ? "Voice mode active — tap to end"
              : "Talk with Ora — voice conversation mode"
      }
      style={{
        width: dim,
        height: dim,
        borderRadius: dim / 2,
        alignItems: "center",
        justifyContent: "center",
        opacity: disabled && !isInert ? 0.4 : 1,
      }}
    >
      {listening && (
        <Animated.View
          pointerEvents="none"
          style={{
            position: "absolute",
            width: dim,
            height: dim,
            borderRadius: dim / 2,
            backgroundColor: "rgba(248,113,113,0.35)",
            transform: [{ scale: ping.interpolate({ inputRange: [0, 1], outputRange: [1, 2] }) }],
            opacity: ping.interpolate({ inputRange: [0, 1], outputRange: [0.6, 0] }),
          }}
        />
      )}
      {isInert ? (
        <View
          style={{
            width: dim,
            height: dim,
            borderRadius: dim / 2,
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: "rgba(120,120,120,0.25)",
          }}
        >
          <MicOff size={size === "sm" ? 12 : 14} color="#9CA3AF" />
        </View>
      ) : (
        <LinearGradient
          colors={["#904CF0", "#3E77EA"]}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={{
            width: dim,
            height: dim,
            borderRadius: dim / 2,
            alignItems: "center",
            justifyContent: "center",
            borderWidth: listening ? 2 : 0,
            borderColor: listening ? "rgba(248,113,113,0.8)" : "transparent",
            shadowColor: "#904CF0",
            shadowOpacity: speaking ? 0.6 : 0.3,
            shadowRadius: speaking ? 8 : 4,
            shadowOffset: { width: 0, height: 2 },
            elevation: speaking ? 6 : 2,
          }}
        >
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
                    backgroundColor: "rgba(255,255,255,0.9)",
                    height: isAnimating
                      ? v.interpolate({ inputRange: [0, 1], outputRange: [hMin, hMax] })
                      : Math.round((hMin + hMax) / 2),
                  }}
                />
              );
            })}
          </View>
        </LinearGradient>
      )}
    </Pressable>
  );
}
