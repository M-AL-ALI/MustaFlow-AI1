import { type CSSProperties, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

export type AtomState =
  | "idle"
  | "thinking"
  | "replying"
  | "uploading"
  | "reading"
  | "analyzing"
  | "builder-ready"
  | "success"
  | "error";

interface DynamicAtomProps {
  state?: AtomState;
  size?: number;
  className?: string;
  accentColor?: string;
}

function parseHsl(hsl: string): [number, number, number] {
  const m = hsl.match(/hsl\(\s*(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)%\s+(\d+(?:\.\d+)?)%/);
  return m ? [+m[1], +m[2], +m[3]] : [265, 85, 65];
}

const STATE_KEYFRAMES = `
@keyframes ora-orbit-slow {
  from { transform: rotate(0deg) translateX(var(--orbit-r)) rotate(0deg); }
  to   { transform: rotate(360deg) translateX(var(--orbit-r)) rotate(-360deg); }
}
@keyframes ora-orbit-fast {
  from { transform: rotate(0deg) translateX(var(--orbit-r)) rotate(0deg); }
  to   { transform: rotate(360deg) translateX(var(--orbit-r)) rotate(-360deg); }
}
@keyframes ora-orbit-rev-slow {
  from { transform: rotate(0deg) translateX(calc(-1 * var(--orbit-r))) rotate(0deg); }
  to   { transform: rotate(-360deg) translateX(calc(-1 * var(--orbit-r))) rotate(360deg); }
}
@keyframes ora-orbit-rev-fast {
  from { transform: rotate(0deg) translateX(calc(-1 * var(--orbit-r))) rotate(0deg); }
  to   { transform: rotate(-360deg) translateX(calc(-1 * var(--orbit-r))) rotate(360deg); }
}
@keyframes ora-core-pulse {
  0%, 100% { opacity: 1; transform: scale(1); }
  50%       { opacity: 0.6; transform: scale(0.82); }
}
@keyframes ora-core-thinking {
  0%, 100% { opacity: 1; transform: scale(1); }
  33%       { opacity: 0.5; transform: scale(0.75); }
  66%       { opacity: 0.9; transform: scale(1.08); }
}
@keyframes ora-glow-idle {
  0%, 100% { opacity: 0.35; transform: scale(1); }
  50%       { opacity: 0.6; transform: scale(1.12); }
}
@keyframes ora-glow-active {
  0%, 100% { opacity: 0.55; transform: scale(1); }
  50%       { opacity: 0.9; transform: scale(1.25); }
}
@keyframes ora-success-shimmer {
  0%, 100% { opacity: 0.5; transform: scale(1); }
  50%       { opacity: 1; transform: scale(1.18); }
}
@keyframes ora-error-pulse {
  0%, 100% { opacity: 0.6; transform: scale(1); }
  50%       { opacity: 1; transform: scale(1.15); }
}
@keyframes ora-badge-pop {
  0%   { transform: scale(0.6); opacity: 0; }
  70%  { transform: scale(1.15); opacity: 1; }
  100% { transform: scale(1); opacity: 1; }
}
`;

let styleInjected = false;
function injectStyles() {
  if (styleInjected || typeof document === "undefined") return;
  const el = document.createElement("style");
  el.textContent = STATE_KEYFRAMES;
  document.head.appendChild(el);
  styleInjected = true;
}

function BadgeIcon({ state, r }: { state: AtomState; r: number }) {
  const s = r * 0.52;
  const offset = r * 0.58;

  let icon: React.ReactNode = null;
  let color = "hsl(265 85% 65%)";

  if (state === "uploading") {
    color = "hsl(220 80% 65%)";
    icon = (
      <g>
        <line x1="0" y1="3" x2="0" y2="-3" stroke={color} strokeWidth="1.5" strokeLinecap="round" />
        <polyline
          points="-2,0 0,-3 2,0"
          fill="none"
          stroke={color}
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </g>
    );
  } else if (state === "reading") {
    color = "hsl(200 75% 60%)";
    icon = (
      <g>
        <rect
          x="-3"
          y="-3.5"
          width="6"
          height="7"
          rx="0.8"
          fill="none"
          stroke={color}
          strokeWidth="1.2"
        />
        <line
          x1="-1.5"
          y1="-1"
          x2="1.5"
          y2="-1"
          stroke={color}
          strokeWidth="1"
          strokeLinecap="round"
        />
        <line
          x1="-1.5"
          y1="0.8"
          x2="1.5"
          y2="0.8"
          stroke={color}
          strokeWidth="1"
          strokeLinecap="round"
        />
        <line
          x1="-1.5"
          y1="2.2"
          x2="0.5"
          y2="2.2"
          stroke={color}
          strokeWidth="1"
          strokeLinecap="round"
        />
      </g>
    );
  } else if (state === "analyzing") {
    color = "hsl(280 75% 65%)";
    icon = (
      <g>
        <rect
          x="-3.5"
          y="-3.5"
          width="7"
          height="7"
          rx="0.8"
          fill="none"
          stroke={color}
          strokeWidth="1.2"
        />
        <line x1="-3.5" y1="-0.5" x2="3.5" y2="-0.5" stroke={color} strokeWidth="0.8" />
        <line x1="-0.5" y1="-3.5" x2="-0.5" y2="3.5" stroke={color} strokeWidth="0.8" />
      </g>
    );
  } else if (state === "builder-ready") {
    color = "hsl(265 85% 70%)";
    icon = (
      <g>
        <polygon
          points="0,-3.5 1,-1 3.5,-1 1.5,0.8 2.5,3.5 0,2 -2.5,3.5 -1.5,0.8 -3.5,-1 -1,-1"
          fill={color}
          opacity="0.9"
        />
      </g>
    );
  }

  if (!icon) return null;

  return (
    <g
      transform={`translate(${offset}, ${-offset})`}
      style={{
        animation: "ora-badge-pop 0.35s cubic-bezier(0.34,1.56,0.64,1) forwards",
      }}
    >
      <circle cx="0" cy="0" r={s} fill="hsl(var(--card))" stroke={color} strokeWidth="1" />
      <g transform="scale(0.75)">{icon}</g>
    </g>
  );
}

export function DynamicAtom({
  state = "idle",
  size = 32,
  className,
  accentColor,
}: DynamicAtomProps) {
  injectStyles();

  const cx = size / 2;
  const cy = size / 2;
  const coreR = size * 0.15;
  const glowR = size * 0.28;
  const orbitR = size * 0.40;
  const ellipseRx = size * 0.44;
  const ellipseRy = size * 0.175;
  const electronR = size * 0.065;

  const isActive = state === "thinking" || state === "replying";
  const isWorking =
    state === "uploading" ||
    state === "reading" ||
    state === "analyzing" ||
    state === "builder-ready";
  const isSuccess = state === "success";
  const isError = state === "error";

  const isFast = isActive || isWorking;

  const ringBlur = isActive ? size * 0.32 : size * 0.22;
  const ringSpread = isActive ? size * 0.06 : size * 0.02;
  const ringOpacity = isSuccess || isError ? 0.55 : isActive ? 0.48 : isWorking ? 0.36 : 0.28;

  const orbitDuration = isFast ? "0.9s" : "3.2s";
  const orbitRevDuration = isFast ? "1.3s" : "4.8s";

  const [aH, aS, aL] = parseHsl(accentColor ?? "hsl(265 85% 65%)");

  const coreColor = isSuccess
    ? "hsl(145 65% 55%)"
    : isError
      ? "hsl(0 75% 58%)"
      : `hsl(${aH} ${aS}% ${aL}%)`;

  const electronColor1 = isSuccess
    ? "hsl(145 65% 65%)"
    : isError
      ? "hsl(30 85% 60%)"
      : `hsl(${aH} ${aS}% ${Math.min(aL + 10, 90)}%)`;
  const electronColor2 = isSuccess
    ? "hsl(145 55% 70%)"
    : isError
      ? "hsl(0 75% 65%)"
      : `hsl(${Math.max(aH - 40, 0)} ${Math.max(aS - 5, 40)}% ${Math.min(aL + 5, 88)}%)`;

  const glowColor = isSuccess
    ? "hsl(145 65% 55% / 0.45)"
    : isError
      ? "hsl(0 75% 55% / 0.45)"
      : `hsl(${aH} ${aS}% ${aL}% / 0.3)`;

  const ringColorBase = isSuccess ? `145 65% 55%` : isError ? `0 75% 58%` : `${aH} ${aS}% ${aL}%`;
  const ringBoxShadow = `0 0 ${ringBlur.toFixed(1)}px ${ringSpread.toFixed(1)}px hsl(${ringColorBase} / ${ringOpacity})`;

  const orbitRingColor = isError
    ? "hsl(30 85% 58% / 0.35)"
    : isSuccess
      ? "hsl(145 65% 55% / 0.35)"
      : `hsl(${aH} ${aS}% ${aL}% / 0.2)`;

  // ── Smooth orbit speed transition ─────────────────────────────────────────
  // CSS cannot animate `animation-duration`, so we briefly fade the electrons
  // out while the new speed snaps in, then fade them back. The 220ms fade
  // out/in window makes the speed change imperceptible.
  const [electronsVisible, setElectronsVisible] = useState(true);
  const prevIsFastRef = useRef(isFast);

  useEffect(() => {
    if (prevIsFastRef.current === isFast) return;
    prevIsFastRef.current = isFast;
    setElectronsVisible(false);
    const t = setTimeout(() => setElectronsVisible(true), 220);
    return () => clearTimeout(t);
  }, [isFast]);

  const orbitStyle = (reverse: boolean, delay = "0s"): CSSProperties =>
    ({
      "--orbit-r": `${orbitR}px`,
      transformOrigin: `${cx}px ${cy}px`,
      animationName: reverse
        ? isFast
          ? "ora-orbit-rev-fast"
          : "ora-orbit-rev-slow"
        : isFast
          ? "ora-orbit-fast"
          : "ora-orbit-slow",
      animationDuration: reverse ? orbitRevDuration : orbitDuration,
      animationTimingFunction: "linear",
      animationIterationCount: "infinite",
      animationDelay: delay,
      transition: "fill 250ms ease",
    }) as CSSProperties;

  // ── Glow cross-fade ───────────────────────────────────────────────────────
  // Two stacked glow circles — one for each animation style — fade between
  // them with CSS opacity transitions so the breathing speed cross-fades.
  const glowSharedBase: CSSProperties = {
    transformOrigin: `${cx}px ${cy}px`,
    transition: "opacity 350ms ease, fill 250ms ease",
  };

  const glowIdleStyle: CSSProperties = {
    ...glowSharedBase,
    animation: "ora-glow-idle 2.4s ease-in-out infinite",
    opacity: !isActive && !isSuccess && !isError ? 1 : 0,
  };

  const glowActiveStyle: CSSProperties = {
    ...glowSharedBase,
    animation: "ora-glow-active 0.8s ease-in-out infinite",
    opacity: isActive ? 1 : 0,
  };

  const glowSuccessStyle: CSSProperties = {
    ...glowSharedBase,
    animation: "ora-success-shimmer 1.6s ease-in-out infinite",
    opacity: isSuccess ? 1 : 0,
  };

  const glowErrorStyle: CSSProperties = {
    ...glowSharedBase,
    animation: "ora-error-pulse 0.9s ease-in-out infinite",
    opacity: isError ? 1 : 0,
  };

  // ── Core animation cross-fade ─────────────────────────────────────────────
  // Two stacked core circles — idle (no animation) and thinking — fade between
  // them so the pulsing animation eases in/out rather than snapping.
  const coreSharedBase: CSSProperties = {
    transformOrigin: `${cx}px ${cy}px`,
    transition: "opacity 350ms ease, fill 250ms ease",
  };

  const coreIdleStyle: CSSProperties = {
    ...coreSharedBase,
    opacity: !isActive && !isWorking ? 1 : 0,
  };

  const coreThinkingStyle: CSSProperties = {
    ...coreSharedBase,
    animation: "ora-core-thinking 1.1s ease-in-out infinite",
    opacity: isActive ? 1 : 0,
  };

  const coreWorkingStyle: CSSProperties = {
    ...coreSharedBase,
    animation: "ora-core-pulse 1.8s ease-in-out infinite",
    opacity: isWorking ? 1 : 0,
  };

  return (
    <span
      className={cn("inline-flex shrink-0 rounded-full", className)}
      style={{
        boxShadow: ringBoxShadow,
        transition: "box-shadow 250ms ease",
      }}
    >
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden>
        {/* Glow — four stacked layers, opacity cross-fades between them */}
        <circle cx={cx} cy={cy} r={glowR} fill={glowColor} style={glowIdleStyle} />
        <circle cx={cx} cy={cy} r={glowR} fill={glowColor} style={glowActiveStyle} />
        <circle cx={cx} cy={cy} r={glowR} fill={glowColor} style={glowSuccessStyle} />
        <circle cx={cx} cy={cy} r={glowR} fill={glowColor} style={glowErrorStyle} />

        {/* Orbit ring 1 — tilted -40° (3D perspective ellipse) */}
        <ellipse
          cx={cx}
          cy={cy}
          rx={ellipseRx}
          ry={ellipseRy}
          fill="none"
          stroke={orbitRingColor}
          strokeWidth="0.8"
          transform={`rotate(-40 ${cx} ${cy})`}
          style={{ transition: "stroke 250ms ease" }}
        />
        {/* Orbit ring 2 — tilted +40° (3D perspective ellipse) */}
        <ellipse
          cx={cx}
          cy={cy}
          rx={ellipseRx}
          ry={ellipseRy}
          fill="none"
          stroke={orbitRingColor}
          strokeWidth="0.8"
          transform={`rotate(40 ${cx} ${cy})`}
          style={{ transition: "stroke 250ms ease" }}
        />

        {/* Electrons — group fades out/in on speed change so the snap is hidden */}
        <g style={{ opacity: electronsVisible ? 1 : 0, transition: "opacity 200ms ease" }}>
          {/* Electron 1 */}
          <circle
            cx={cx + orbitR}
            cy={cy}
            r={electronR}
            fill={electronColor1}
            style={orbitStyle(false)}
          />
          {/* Electron 2 — reverse, offset */}
          <circle
            cx={cx - orbitR}
            cy={cy}
            r={electronR * 0.85}
            fill={electronColor2}
            style={orbitStyle(true, "-0.4s")}
          />
          {/* Electron 3 — 3rd ring, slower phase */}
          <circle
            cx={cx + orbitR}
            cy={cy}
            r={electronR * 0.7}
            fill="hsl(200 75% 70%)"
            style={orbitStyle(false, "-1.2s")}
          />
        </g>

        {/* Core — three stacked layers, opacity cross-fades between animation styles */}
        <circle cx={cx} cy={cy} r={coreR} fill={coreColor} style={coreIdleStyle} />
        <circle cx={cx} cy={cy} r={coreR} fill={coreColor} style={coreThinkingStyle} />
        <circle cx={cx} cy={cy} r={coreR} fill={coreColor} style={coreWorkingStyle} />
        {/* 3D sphere highlight — offset upper-left to give depth illusion */}
        <circle cx={cx - coreR * 0.3} cy={cy - coreR * 0.3} r={coreR * 0.42} fill="white" opacity="0.45" />

        {/* Badge overlay for contextual states */}
        {isWorking && <BadgeIcon state={state} r={size * 0.42} />}

        {/* Error ring */}
        {isError && (
          <circle
            cx={cx}
            cy={cy}
            r={size * 0.42}
            fill="none"
            stroke="hsl(0 75% 58% / 0.6)"
            strokeWidth="1.2"
            style={{
              transformOrigin: `${cx}px ${cy}px`,
              animation: "ora-error-pulse 0.9s ease-in-out infinite",
            }}
          />
        )}
      </svg>
    </span>
  );
}
