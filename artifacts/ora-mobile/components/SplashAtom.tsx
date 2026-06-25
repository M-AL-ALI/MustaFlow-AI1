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
 * SplashAtom — animated version of the static startup splash (assets/splash-ora.png).
 *
 * The native splash is a baked PNG and cannot move, so this recreates the SAME
 * filled-sphere Ora atom the user approved — a solid green orb with a brighter
 * core + white highlight, two faint tilted orbit rings, and three electrons —
 * but brings it to life: the electrons orbit and the orb gently breathes.
 *
 * Colours are sampled to match splash-ora.png so the JS overlay can hand off
 * seamlessly from the native launch image.
 */
export function SplashAtom({
  size = 168,
  color = "#10A37F",
  style,
}: {
  size?: number;
  color?: string;
  style?: ViewStyle;
}) {
  const cx = size / 2;
  const cy = size / 2;
  const glowR = size * 0.46;
  const sphereR = size * 0.34;
  const coreR = size * 0.135;
  const ringRx = size * 0.34;
  const ringRy = size * 0.135;
  const orbitR = size * 0.35;
  const electronR = size * 0.05;
  const ringWidth = Math.max(size * 0.012, 1);

  const spin = useSharedValue(0);
  const spinRev = useSharedValue(0);
  const breathe = useSharedValue(0);

  useEffect(() => {
    spin.value = withRepeat(withTiming(1, { duration: 4000, easing: Easing.linear }), -1, false);
    spinRev.value = withRepeat(withTiming(1, { duration: 6000, easing: Easing.linear }), -1, false);
    breathe.value = withRepeat(
      withTiming(1, { duration: 2600, easing: Easing.inOut(Easing.ease) }),
      -1,
      true,
    );
    return () => {
      cancelAnimation(spin);
      cancelAnimation(spinRev);
      cancelAnimation(breathe);
    };
  }, [spin, spinRev, breathe]);

  const layer: ViewStyle = {
    position: "absolute",
    left: 0,
    top: 0,
    width: size,
    height: size,
  };

  const glowStyle = useAnimatedStyle(() => ({
    opacity: 0.5 + breathe.value * 0.35,
    transform: [{ scale: 1 + breathe.value * 0.1 }],
  }));
  const sphereStyle = useAnimatedStyle(() => ({
    transform: [{ scale: 1 + breathe.value * 0.04 }],
  }));
  const spinStyle = useAnimatedStyle(() => ({
    transform: [{ rotate: `${spin.value * 360}deg` }],
  }));
  const spinRevStyle = useAnimatedStyle(() => ({
    transform: [{ rotate: `${spinRev.value * -360}deg` }],
  }));

  return (
    <View style={[{ width: size, height: size }, style]}>
      {/* Soft outer halo — breathing radial gradient */}
      <Animated.View style={[layer, glowStyle]} pointerEvents="none">
        <Svg width={size} height={size}>
          <Defs>
            <RadialGradient id="splashGlow" cx="50%" cy="50%" r="50%">
              <Stop offset="0%" stopColor={color} stopOpacity={0.55} />
              <Stop offset="55%" stopColor={color} stopOpacity={0.18} />
              <Stop offset="100%" stopColor={color} stopOpacity={0} />
            </RadialGradient>
          </Defs>
          <Circle cx={cx} cy={cy} r={glowR} fill="url(#splashGlow)" />
        </Svg>
      </Animated.View>

      {/* Filled sphere + core + highlight — gentle breathing */}
      <Animated.View style={[layer, sphereStyle]} pointerEvents="none">
        <Svg width={size} height={size}>
          <Defs>
            <RadialGradient id="splashSphere" cx="50%" cy="50%" r="50%">
              <Stop offset="0%" stopColor="#1FBE90" stopOpacity={1} />
              <Stop offset="70%" stopColor={color} stopOpacity={1} />
              <Stop offset="100%" stopColor="#0C8A66" stopOpacity={1} />
            </RadialGradient>
          </Defs>
          <Circle cx={cx} cy={cy} r={sphereR} fill="url(#splashSphere)" />
          <Circle cx={cx} cy={cy} r={coreR} fill="#33CDA0" fillOpacity={0.9} />
          <Circle
            cx={cx - coreR * 0.4}
            cy={cy - coreR * 0.4}
            r={coreR * 0.5}
            fill="#ffffff"
            fillOpacity={0.6}
          />
        </Svg>
      </Animated.View>

      {/* Two faint tilted orbit rings, drawn over the sphere */}
      <View style={layer} pointerEvents="none">
        <Svg width={size} height={size}>
          <Ellipse
            cx={cx}
            cy={cy}
            rx={ringRx}
            ry={ringRy}
            fill="none"
            stroke="#0A6E52"
            strokeOpacity={0.4}
            strokeWidth={ringWidth}
            rotation={-35}
            origin={`${cx}, ${cy}`}
          />
          <Ellipse
            cx={cx}
            cy={cy}
            rx={ringRx}
            ry={ringRy}
            fill="none"
            stroke="#0A6E52"
            strokeOpacity={0.4}
            strokeWidth={ringWidth}
            rotation={35}
            origin={`${cx}, ${cy}`}
          />
        </Svg>
      </View>

      {/* Electrons A — orbit clockwise (two electrons) */}
      <Animated.View style={[layer, spinStyle]} pointerEvents="none">
        <Svg width={size} height={size}>
          <Circle cx={cx + orbitR} cy={cy} r={electronR} fill="#2BD49C" />
          <Circle cx={cx - orbitR} cy={cy} r={electronR * 0.85} fill="#2BD49C" fillOpacity={0.9} />
        </Svg>
      </Animated.View>

      {/* Electron B — orbit counter-clockwise (one electron) */}
      <Animated.View style={[layer, spinRevStyle]} pointerEvents="none">
        <Svg width={size} height={size}>
          <Circle cx={cx} cy={cy - orbitR} r={electronR * 0.9} fill="#2BD49C" fillOpacity={0.95} />
        </Svg>
      </Animated.View>
    </View>
  );
}
