import { View, type ViewStyle } from "react-native";
import Svg, { Circle, Ellipse } from "react-native-svg";

/**
 * OraAtom — native mirror of the website Ora `DynamicAtom` (idle state).
 *
 * The website atom (artifacts/mustaflow/src/components/ora/dynamic-atom.tsx) is an
 * animated SVG that relies on the DOM + CSS keyframes, which do not exist in React
 * Native. This renders a faithful static snapshot of its idle look — glow, two
 * tilted orbit rings, electrons sitting on the rings, and a highlighted core —
 * tinted by the active plan accent so the brand identity matches across surfaces.
 */
export function OraAtom({
  size = 32,
  accentColor = "#995AF2",
  style,
}: {
  size?: number;
  accentColor?: string;
  style?: ViewStyle;
}) {
  const cx = size / 2;
  const cy = size / 2;
  const coreR = size * 0.15;
  const glowR = size * 0.3;
  const rx = size * 0.44;
  const ry = size * 0.175;
  const electronR = Math.max(size * 0.07, 1.2);
  const ringWidth = Math.max(size * 0.025, 0.8);

  // Place electrons on the major-axis tips of the tilted ellipses so they read as
  // orbiting particles. tip(deg, sign) returns the endpoint of an ellipse rotated
  // by `deg` degrees, along its major axis in the +/- direction.
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
