import React, { useEffect } from "react";
import Svg, { Circle, Ellipse, G } from "react-native-svg";
import Animated, {
  Easing,
  interpolate,
  useAnimatedProps,
  useSharedValue,
  withRepeat,
  withTiming,
} from "react-native-reanimated";

const AnimatedCircle = Animated.createAnimatedComponent(Circle);

type OraAtomProps = {
  size?: number;
  accentColor: string;
  animated?: boolean;
};

function hexToRgb(hex: string) {
  const clean = hex.replace("#", "");
  const value =
    clean.length === 3
      ? clean
          .split("")
          .map((c) => c + c)
          .join("")
      : clean;
  const n = Number.parseInt(value.slice(0, 6), 16);
  return {
    r: (n >> 16) & 255,
    g: (n >> 8) & 255,
    b: n & 255,
  };
}

function rgba(hex: string, alpha: number) {
  const { r, g, b } = hexToRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

export function OraAtom({ size = 24, accentColor, animated = true }: OraAtomProps) {
  const spin = useSharedValue(0);
  const reverseSpin = useSharedValue(0);
  const breathe = useSharedValue(0);

  useEffect(() => {
    if (!animated) {
      spin.value = 0;
      reverseSpin.value = 0;
      breathe.value = 0;
      return;
    }
    spin.value = withRepeat(withTiming(1, { duration: 3200, easing: Easing.linear }), -1, false);
    reverseSpin.value = withRepeat(
      withTiming(1, { duration: 4800, easing: Easing.linear }),
      -1,
      false,
    );
    breathe.value = withRepeat(
      withTiming(1, { duration: 2400, easing: Easing.inOut(Easing.ease) }),
      -1,
      true,
    );
  }, [animated, breathe, reverseSpin, spin]);

  const cx = size / 2;
  const cy = size / 2;
  const coreR = size * 0.15;
  const glowR = size * 0.28;
  const orbitR = size * 0.4;
  const ellipseRx = size * 0.44;
  const ellipseRy = size * 0.175;
  const electronR = size * 0.065;

  const glowProps = useAnimatedProps(() => ({
    opacity: animated ? interpolate(breathe.value, [0, 1], [0.55, 1]) : 0.8,
    r: animated ? interpolate(breathe.value, [0, 1], [glowR * 0.9, glowR * 1.16]) : glowR,
  }));

  const corePulseProps = useAnimatedProps(() => ({
    r: animated ? interpolate(breathe.value, [0, 1], [coreR * 0.94, coreR * 1.08]) : coreR,
  }));

  const electronOneProps = useAnimatedProps(() => {
    const angle = spin.value * Math.PI * 2;
    return {
      cx: cx + Math.cos(angle) * orbitR,
      cy: cy + Math.sin(angle) * orbitR,
    };
  });

  const electronTwoProps = useAnimatedProps(() => {
    const angle = reverseSpin.value * Math.PI * -2 - 0.4;
    return {
      cx: cx + Math.cos(angle) * orbitR,
      cy: cy + Math.sin(angle) * orbitR,
    };
  });

  const electronThreeProps = useAnimatedProps(() => {
    const angle = spin.value * Math.PI * 2 - 1.2;
    return {
      cx: cx + Math.cos(angle) * orbitR,
      cy: cy + Math.sin(angle) * orbitR,
    };
  });

  return (
    <Svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
      <AnimatedCircle cx={cx} cy={cy} animatedProps={glowProps} fill={rgba(accentColor, 0.3)} />
      <Ellipse
        cx={cx}
        cy={cy}
        rx={ellipseRx}
        ry={ellipseRy}
        fill="none"
        stroke={rgba(accentColor, 0.2)}
        strokeWidth={0.8}
        transform={`rotate(-40 ${cx} ${cy})`}
      />
      <Ellipse
        cx={cx}
        cy={cy}
        rx={ellipseRx}
        ry={ellipseRy}
        fill="none"
        stroke={rgba(accentColor, 0.2)}
        strokeWidth={0.8}
        transform={`rotate(40 ${cx} ${cy})`}
      />
      <G>
        <AnimatedCircle animatedProps={electronOneProps} r={electronR} fill={accentColor} />
        <AnimatedCircle
          animatedProps={electronTwoProps}
          r={electronR * 0.85}
          fill={rgba(accentColor, 0.82)}
        />
        <AnimatedCircle animatedProps={electronThreeProps} r={electronR * 0.7} fill="#8bd8ec" />
      </G>
      <AnimatedCircle cx={cx} cy={cy} animatedProps={corePulseProps} fill={accentColor} />
      <Circle
        cx={cx - coreR * 0.3}
        cy={cy - coreR * 0.3}
        r={coreR * 0.42}
        fill="#fff"
        opacity={0.45}
      />
    </Svg>
  );
}
