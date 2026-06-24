import { useEffect } from "react";
import { View, type ViewStyle } from "react-native";
import Animated, {
  Easing,
  cancelAnimation,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from "react-native-reanimated";
import Svg, { Circle, Defs, Ellipse, RadialGradient, Stop } from "react-native-svg";

/**
 * OraAtom — native mirror of the website Ora `DynamicAtom` (idle state).
 *
 * The website atom (artifacts/mustaflow/src/components/ora/dynamic-atom.tsx) is a
 * DOM/CSS-only animated SVG that cannot run in React Native. This recreates its idle
 * look natively:
 *   - a soft radial halo/glow that breathes,
 *   - two faint tilted orbit rings,
 *   - three electrons that orbit the core (two one way, one the other),
 *   - a highlighted core that gently pulses,
 * tinted by the active plan accent so brand identity matches across surfaces.
 *
 * Pass `animated` for the live (empty-state hero) treatment. Without it the atom
 * renders the original static snapshot, so existing call sites are unchanged.
 */
export function OraAtom({
  size = 32,
  accentColor = "#995AF2",
  style,
  animated = false,
}: {
  size?: number;
  accentColor?: string;
  style?: ViewStyle;
  animated?: boolean;
}) {
  const cx = size / 2;
  const cy = size / 2;
  const coreR = size * 0.15;
  const rx = size * 0.44;
  const ry = size * 0.175;
  const orbitR = size * 0.4;
  const electronR = Math.max(size * 0.065, 1.1);
  const ringWidth = Math.max(size * 0.022, 0.7);

  const spin = useSharedValue(0);
  const spinRev = useSharedValue(0);
  const breathe = useSharedValue(0);

  useEffect(() => {
    if (!animated) return;
    spin.value = withRepeat(withTiming(1, { duration: 3200, easing: Easing.linear }), -1, false);
    spinRev.value = withRepeat(withTiming(1, { duration: 4800, easing: Easing.linear }), -1, false);
    breathe.value = withRepeat(
      withTiming(1, { duration: 2400, easing: Easing.inOut(Easing.ease) }),
      -1,
      true,
    );
    return () => {
      cancelAnimation(spin);
      cancelAnimation(spinRev);
      cancelAnimation(breathe);
    };
  }, [animated, spin, spinRev, breathe]);

  const spinStyle = useAnimatedStyle(() => ({
    transform: [{ rotate: `${spin.value * 360}deg` }],
  }));
  const spinRevStyle = useAnimatedStyle(() => ({
    transform: [{ rotate: `${spinRev.value * -360}deg` }],
  }));
  const glowStyle = useAnimatedStyle(() => ({
    opacity: 0.4 + breathe.value * 0.3,
    transform: [{ scale: 1 + breathe.value * 0.12 }],
  }));
  const coreStyle = useAnimatedStyle(() => ({
    opacity: 1 - breathe.value * 0.12,
    transform: [{ scale: 1 - breathe.value * 0.06 }],
  }));

  // ── Static snapshot (used by every existing call site) ─────────────────────
  if (!animated) {
    const glowR = size * 0.3;
    const tip = (deg: number, sign: number) => {
      const r = (deg * Math.PI) / 180;
      return { x: cx + sign * rx * Math.cos(r), y: cy + sign * rx * Math.sin(r) };
    };
    const e1 = tip(-40, 1);
    const e2 = tip(40, -1);
    const e3 = tip(40, 1);
    return (
      <View style={style}>
        <Svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
          <Circle cx={cx} cy={cy} r={glowR} fill={accentColor} fillOpacity={0.16} />
          <Ellipse
            cx={cx}
            cy={cy}
            rx={rx}
            ry={ry}
            fill="none"
            stroke={accentColor}
            strokeOpacity={0.35}
            strokeWidth={ringWidth}
            rotation={-40}
            origin={`${cx}, ${cy}`}
          />
          <Ellipse
            cx={cx}
            cy={cy}
            rx={rx}
            ry={ry}
            fill="none"
            stroke={accentColor}
            strokeOpacity={0.35}
            strokeWidth={ringWidth}
            rotation={40}
            origin={`${cx}, ${cy}`}
          />
          <Circle cx={e1.x} cy={e1.y} r={electronR} fill={accentColor} />
          <Circle cx={e2.x} cy={e2.y} r={electronR * 0.85} fill={accentColor} fillOpacity={0.8} />
          <Circle cx={e3.x} cy={e3.y} r={electronR * 0.7} fill={accentColor} fillOpacity={0.7} />
          <Circle cx={cx} cy={cy} r={coreR} fill={accentColor} />
          <Circle
            cx={cx - coreR * 0.3}
            cy={cy - coreR * 0.3}
            r={coreR * 0.42}
            fill="#ffffff"
            fillOpacity={0.45}
          />
        </Svg>
      </View>
    );
  }

  // ── Animated (live) treatment ──────────────────────────────────────────────
  const layer: ViewStyle = {
    position: "absolute",
    left: 0,
    top: 0,
    width: size,
    height: size,
  };

  return (
    <View style={[{ width: size, height: size }, style]}>
      {/* Halo + glow — breathing radial gradient (core glow + soft outer halo) */}
      <Animated.View style={[layer, glowStyle]} pointerEvents="none">
        <Svg width={size} height={size}>
          <Defs>
            <RadialGradient id="oraAtomGlow" cx="50%" cy="50%" r="50%">
              <Stop offset="0%" stopColor={accentColor} stopOpacity={0.55} />
              <Stop offset="45%" stopColor={accentColor} stopOpacity={0.22} />
              <Stop offset="100%" stopColor={accentColor} stopOpacity={0} />
            </RadialGradient>
          </Defs>
          <Circle cx={cx} cy={cy} r={size * 0.5} fill="url(#oraAtomGlow)" />
        </Svg>
      </Animated.View>

      {/* Orbit rings — two faint tilted ellipses (static) */}
      <View style={layer} pointerEvents="none">
        <Svg width={size} height={size}>
          <Ellipse
            cx={cx}
            cy={cy}
            rx={rx}
            ry={ry}
            fill="none"
            stroke={accentColor}
            strokeOpacity={0.22}
            strokeWidth={ringWidth}
            rotation={-40}
            origin={`${cx}, ${cy}`}
          />
          <Ellipse
            cx={cx}
            cy={cy}
            rx={rx}
            ry={ry}
            fill="none"
            stroke={accentColor}
            strokeOpacity={0.22}
            strokeWidth={ringWidth}
            rotation={40}
            origin={`${cx}, ${cy}`}
          />
        </Svg>
      </View>

      {/* Electrons A — orbit clockwise */}
      <Animated.View style={[layer, spinStyle]} pointerEvents="none">
        <Svg width={size} height={size}>
          <Circle cx={cx + orbitR} cy={cy} r={electronR} fill={accentColor} />
          {/* Small forward electron — fixed cyan tint, mirroring the website
              DynamicAtom's third electron (hsl(200 75% 70%)) which is the same
              regardless of plan accent. */}
          <Circle cx={cx - orbitR} cy={cy} r={electronR * 0.7} fill="#79C6EC" fillOpacity={0.9} />
        </Svg>
      </Animated.View>

      {/* Electron B — orbit counter-clockwise */}
      <Animated.View style={[layer, spinRevStyle]} pointerEvents="none">
        <Svg width={size} height={size}>
          <Circle
            cx={cx}
            cy={cy - orbitR}
            r={electronR * 0.85}
            fill={accentColor}
            fillOpacity={0.85}
          />
        </Svg>
      </Animated.View>

      {/* Core — breathing, with 3D highlight */}
      <Animated.View style={[layer, coreStyle]} pointerEvents="none">
        <Svg width={size} height={size}>
          <Circle cx={cx} cy={cy} r={coreR} fill={accentColor} />
          <Circle
            cx={cx - coreR * 0.3}
            cy={cy - coreR * 0.3}
            r={coreR * 0.42}
            fill="#ffffff"
            fillOpacity={0.5}
          />
        </Svg>
      </Animated.View>
    </View>
  );
}
