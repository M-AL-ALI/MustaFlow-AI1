import { useId } from "react";
import { cn } from "@/lib/utils";

interface DynamicAtomProps {
  size?: number;
  className?: string;
  animate?: boolean;
}

export function DynamicAtom({ size = 20, className, animate = true }: DynamicAtomProps) {
  // Use instance-unique IDs so multiple DynamicAtom icons on the same page
  // don't share <path id="orbit1"> definitions, which would cause animation
  // cross-linking and SVG spec violations.
  const uid = useId().replace(/:/g, "");
  const id1 = `${uid}o1`;
  const id2 = `${uid}o2`;
  const id3 = `${uid}o3`;

  const cx = size / 2;
  const cy = size / 2;
  const r = size * 0.12;
  const orbitRx = size * 0.42;
  const orbitRy = size * 0.18;

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={cn(className)}
      aria-hidden="true"
    >
      {/* Orbit 1 — horizontal */}
      <ellipse
        cx={cx}
        cy={cy}
        rx={orbitRx}
        ry={orbitRy}
        stroke="currentColor"
        strokeWidth={size * 0.04}
        opacity={0.35}
        fill="none"
      />
      {/* Orbit 2 — rotated 60° */}
      <ellipse
        cx={cx}
        cy={cy}
        rx={orbitRx}
        ry={orbitRy}
        stroke="currentColor"
        strokeWidth={size * 0.04}
        opacity={0.35}
        fill="none"
        transform={`rotate(60 ${cx} ${cy})`}
      />
      {/* Orbit 3 — rotated 120° */}
      <ellipse
        cx={cx}
        cy={cy}
        rx={orbitRx}
        ry={orbitRy}
        stroke="currentColor"
        strokeWidth={size * 0.04}
        opacity={0.35}
        fill="none"
        transform={`rotate(120 ${cx} ${cy})`}
      />

      {/* Nucleus */}
      <circle cx={cx} cy={cy} r={r} fill="currentColor" opacity={0.9} />

      {/* Electron 1 — orbits the horizontal ellipse */}
      {animate ? (
        <circle r={size * 0.08} fill="currentColor">
          <animateMotion dur="2.4s" repeatCount="indefinite">
            <mpath href={`#${id1}`} />
          </animateMotion>
        </circle>
      ) : (
        <circle cx={cx + orbitRx} cy={cy} r={size * 0.08} fill="currentColor" />
      )}

      {/* Electron 2 — orbits the 60° ellipse */}
      {animate ? (
        <circle r={size * 0.08} fill="currentColor">
          <animateMotion dur="3.1s" repeatCount="indefinite" begin="-1s">
            <mpath href={`#${id2}`} />
          </animateMotion>
        </circle>
      ) : (
        <circle
          cx={cx + orbitRx * Math.cos(Math.PI / 3)}
          cy={cy - orbitRy * Math.sin(Math.PI / 3)}
          r={size * 0.08}
          fill="currentColor"
        />
      )}

      {/* Electron 3 — orbits the 120° ellipse */}
      {animate ? (
        <circle r={size * 0.08} fill="currentColor">
          <animateMotion dur="2.7s" repeatCount="indefinite" begin="-0.5s">
            <mpath href={`#${id3}`} />
          </animateMotion>
        </circle>
      ) : (
        <circle
          cx={cx - orbitRx * 0.5}
          cy={cy + orbitRy * 0.86}
          r={size * 0.08}
          fill="currentColor"
        />
      )}

      {/* Hidden path definitions for animateMotion — instance-scoped IDs */}
      <defs>
        <path
          id={id1}
          d={`M ${cx + orbitRx} ${cy} A ${orbitRx} ${orbitRy} 0 1 1 ${cx + orbitRx - 0.001} ${cy}`}
        />
        <path
          id={id2}
          d={`M ${cx + orbitRx * Math.cos(Math.PI / 3)} ${cy - orbitRy * Math.sin(Math.PI / 3)} A ${orbitRx} ${orbitRy} 60 1 1 ${cx + orbitRx * Math.cos(Math.PI / 3) - 0.001} ${cy - orbitRy * Math.sin(Math.PI / 3)}`}
          transform={`rotate(60 ${cx} ${cy})`}
        />
        <path
          id={id3}
          d={`M ${cx + orbitRx} ${cy} A ${orbitRx} ${orbitRy} 0 1 1 ${cx + orbitRx - 0.001} ${cy}`}
          transform={`rotate(120 ${cx} ${cy})`}
        />
      </defs>
    </svg>
  );
}
