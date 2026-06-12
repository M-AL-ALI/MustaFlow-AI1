import { type CSSProperties } from "react";
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

export function DynamicAtom({ state = "idle", size = 32, className, accentColor }: DynamicAtomProps) {
  injectStyles();

  const cx = size / 2;
  const cy = size / 2;
  const coreR = size * 0.15;
  const glowR = size * 0.28;
  const orbitR = size * 0.3;
  const electronR = size * 0.055;

  const isActive = state === "thinking" || state === "replying";
  const isWorking =
    state === "uploading" ||
    state === "reading" ||
    state === "analyzing" ||
    state === "builder-ready";
  const isSuccess = state === "success";
  const isError = state === "error";

  const orbitDuration = isActive ? "0.9s" : "3.2s";
  const orbitRevDuration = isActive ? "1.3s" : "4.8s";

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

  const orbitRingColor = isError
    ? "hsl(30 85% 58% / 0.35)"
    : isSuccess
      ? "hsl(145 65% 55% / 0.35)"
      : `hsl(${aH} ${aS}% ${aL}% / 0.2)`;

  const orbitStyle = (reverse: boolean, delay = "0s"): CSSProperties =>
    ({
      "--orbit-r": `${orbitR}px`,
      transformOrigin: `${cx}px ${cy}px`,
      animationName: reverse
        ? isActive || isWorking
          ? "ora-orbit-rev-fast"
          : "ora-orbit-rev-slow"
        : isActive || isWorking
          ? "ora-orbit-fast"
          : "ora-orbit-slow",
      animationDuration: reverse ? orbitRevDuration : orbitDuration,
      animationTimingFunction: "linear",
      animationIterationCount: "infinite",
      animationDelay: delay,
    }) as CSSProperties;

  const coreStyle: CSSProperties = isActive
    ? {
        transformOrigin: `${cx}px ${cy}px`,
        animation: `ora-core-thinking 1.1s ease-in-out infinite`,
      }
    : isWorking
      ? {
          transformOrigin: `${cx}px ${cy}px`,
          animation: `ora-core-pulse 1.8s ease-in-out infinite`,
        }
      : {};

  const glowStyle: CSSProperties = isSuccess
    ? {
        transformOrigin: `${cx}px ${cy}px`,
        animation: `ora-success-shimmer 1.6s ease-in-out infinite`,
      }
    : isError
      ? {
          transformOrigin: `${cx}px ${cy}px`,
          animation: `ora-error-pulse 0.9s ease-in-out infinite`,
        }
      : isActive
        ? {
            transformOrigin: `${cx}px ${cy}px`,
            animation: `ora-glow-active 0.8s ease-in-out infinite`,
          }
        : {
            transformOrigin: `${cx}px ${cy}px`,
            animation: `ora-glow-idle 2.4s ease-in-out infinite`,
          };

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      className={cn("shrink-0", className)}
      aria-hidden
    >
      {/* Glow */}
      <circle cx={cx} cy={cy} r={glowR} fill={glowColor} style={glowStyle} />

      {/* Orbit ring 1 — tilted */}
      <ellipse
        cx={cx}
        cy={cy}
        rx={orbitR}
        ry={orbitR * 0.38}
        fill="none"
        stroke={orbitRingColor}
        strokeWidth="0.8"
        transform={`rotate(-35, ${cx}, ${cy})`}
      />
      {/* Orbit ring 2 — tilted other way */}
      <ellipse
        cx={cx}
        cy={cy}
        rx={orbitR}
        ry={orbitR * 0.38}
        fill="none"
        stroke={orbitRingColor}
        strokeWidth="0.8"
        transform={`rotate(35, ${cx}, ${cy})`}
      />

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

      {/* Core */}
      <circle cx={cx} cy={cy} r={coreR} fill={coreColor} style={coreStyle} />
      <circle cx={cx} cy={cy} r={coreR * 0.5} fill="white" opacity="0.35" />

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
  );
}
