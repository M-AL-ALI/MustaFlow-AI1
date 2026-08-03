import { useEffect, useState } from "react";

function useIsDark() {
  const [isDark, setIsDark] = useState(
    () => typeof document !== "undefined" && document.documentElement.classList.contains("dark"),
  );
  useEffect(() => {
    const obs = new MutationObserver(() => {
      setIsDark(document.documentElement.classList.contains("dark"));
    });
    obs.observe(document.documentElement, { attributeFilter: ["class"] });
    return () => obs.disconnect();
  }, []);
  return isDark;
}

interface Brand {
  id: string;
  label: string;
  render: (isDark: boolean) => React.ReactNode;
}

const BRANDS: Brand[] = [
  {
    id: "mustaflow",
    label: "MustaFlow AI — built with this platform",
    render: () => (
      <div className="flex items-center gap-3">
        <img
          src={`${import.meta.env.BASE_URL}logos/mustaflow.png`}
          alt=""
          aria-hidden="true"
          className="h-8 w-8 rounded-lg object-contain"
        />
        <span
          className="text-2xl font-extrabold tracking-tight whitespace-nowrap"
          style={{ color: "hsl(213 90% 52%)" }}
        >
          MustaFlow AI
        </span>
      </div>
    ),
  },
  {
    id: "nabuflow",
    label: "NabuFlow — by MustaFlow AI Technology",
    render: () => (
      <div className="flex items-center gap-3">
        <img
          src={`${import.meta.env.BASE_URL}logos/nabuflow-icon.png`}
          alt=""
          aria-hidden="true"
          className="h-8 w-8 rounded-lg object-contain"
        />
        <span className="flex items-baseline gap-2 whitespace-nowrap">
          <span className="text-2xl font-extrabold tracking-tight text-foreground">NabuFlow</span>
          <span className="text-sm font-medium text-muted-foreground">
            — by MustaFlow AI Technology
          </span>
        </span>
      </div>
    ),
  },
  {
    id: "openai",
    label: "OpenAI — AI capabilities",
    render: () => (
      <div className="flex items-center gap-3">
        <svg width="28" height="28" viewBox="0 0 24 24" aria-hidden="true" fill="#10a37f">
          <path d="M22.282 9.821a5.985 5.985 0 0 0-.516-4.91 6.046 6.046 0 0 0-6.51-2.9A6.065 6.065 0 0 0 4.981 4.18a5.985 5.985 0 0 0-3.998 2.9 6.046 6.046 0 0 0 .743 7.097 5.98 5.98 0 0 0 .51 4.911 6.051 6.051 0 0 0 6.515 2.9A5.985 5.985 0 0 0 13.26 24a6.056 6.056 0 0 0 5.772-4.206 5.99 5.99 0 0 0 3.997-2.9 6.056 6.056 0 0 0-.747-7.073zM13.26 22.43a4.476 4.476 0 0 1-2.876-1.04l.141-.081 4.779-2.758a.795.795 0 0 0 .392-.681v-6.737l2.02 1.168a.071.071 0 0 1 .038.052v5.583a4.504 4.504 0 0 1-4.494 4.494zM3.6 18.304a4.47 4.47 0 0 1-.535-3.014l.142.085 4.783 2.759a.771.771 0 0 0 .78 0l5.843-3.369v2.332a.08.08 0 0 1-.033.062L9.74 19.95a4.5 4.5 0 0 1-6.14-1.646zM2.34 7.896a4.485 4.485 0 0 1 2.366-1.973V11.6a.766.766 0 0 0 .388.676l5.815 3.355-2.02 1.168a.076.076 0 0 1-.071 0l-4.83-2.786A4.504 4.504 0 0 1 2.34 7.872zm16.597 3.855l-5.833-3.387L15.119 7.2a.076.076 0 0 1 .071 0l4.83 2.791a4.494 4.494 0 0 1-.676 8.105v-5.678a.79.79 0 0 0-.407-.667zm2.01-3.023l-.141-.085-4.774-2.782a.776.776 0 0 0-.785 0L9.409 9.23V6.897a.066.066 0 0 1 .028-.061l4.83-2.787a4.5 4.5 0 0 1 6.68 4.66zm-12.64 4.135l-2.02-1.164a.08.08 0 0 1-.038-.057V6.075a4.5 4.5 0 0 1 7.375-3.453l-.142.08L8.704 5.46a.795.795 0 0 0-.393.681zm1.097-2.365l2.602-1.5 2.607 1.5v2.999l-2.597 1.5-2.607-1.5z" />
        </svg>
        <span
          className="text-2xl font-bold tracking-tight whitespace-nowrap"
          style={{ color: "#10a37f" }}
        >
          OpenAI
        </span>
      </div>
    ),
  },
  {
    id: "gemini",
    label: "Google Gemini — AI model powering builds",
    render: (isDark) => {
      const textColor = isDark ? "#A8C7FA" : "#1B72E8";
      return (
        <div className="flex items-center gap-3">
          <svg width="26" height="26" viewBox="0 0 28 28" aria-hidden="true" fill="none">
            <defs>
              <linearGradient id="gemini-grad" x1="0" y1="0" x2="1" y2="1">
                <stop offset="0%" stopColor="#4285F4" />
                <stop offset="50%" stopColor="#9B72CB" />
                <stop offset="100%" stopColor="#1ABCFE" />
              </linearGradient>
            </defs>
            {/* Gemini 4-pointed star */}
            <path
              d="M14 2 C14 2 15.5 9.5 20 14 C15.5 18.5 14 26 14 26 C14 26 12.5 18.5 8 14 C12.5 9.5 14 2 14 2 Z"
              fill="url(#gemini-grad)"
            />
          </svg>
          <span
            className="text-2xl font-bold tracking-tight whitespace-nowrap"
            style={{ color: textColor }}
          >
            Gemini
          </span>
        </div>
      );
    },
  },
  {
    id: "anthropic",
    label: "Anthropic Claude — AI model powering builds",
    render: (isDark) => {
      const color = isDark ? "#DA7756" : "#b85c3a";
      return (
        <div className="flex items-center gap-3">
          <svg width="28" height="24" viewBox="0 0 46 40" aria-hidden="true" fill={color}>
            {/* Anthropic "A" lettermark */}
            <path d="M26.738 0h-7.476L0 40h8.894l3.888-10.154h20.436L37.106 40H46L26.738 0zm-9.607 22.66 6.869-17.94 6.869 17.94H17.131z" />
          </svg>
          <span className="text-2xl font-bold tracking-tight whitespace-nowrap" style={{ color }}>
            Claude
          </span>
        </div>
      );
    },
  },
  {
    id: "google",
    label: "Google — cloud and AI services",
    render: () => (
      <div className="flex items-center gap-3">
        <svg width="28" height="28" viewBox="0 0 24 24" aria-hidden="true">
          <path
            d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
            fill="#4285F4"
          />
          <path
            d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
            fill="#34A853"
          />
          <path
            d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
            fill="#FBBC05"
          />
          <path
            d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
            fill="#EA4335"
          />
        </svg>
        <span className="text-2xl font-bold tracking-tight whitespace-nowrap">
          <span style={{ color: "#4285F4" }}>G</span>
          <span style={{ color: "#EA4335" }}>o</span>
          <span style={{ color: "#FBBC05" }}>o</span>
          <span style={{ color: "#4285F4" }}>g</span>
          <span style={{ color: "#34A853" }}>l</span>
          <span style={{ color: "#EA4335" }}>e</span>
        </span>
      </div>
    ),
  },
  {
    id: "github",
    label: "GitHub — source control and collaboration",
    render: (isDark) => {
      const color = isDark ? "#e6edf3" : "#24292f";
      return (
        <div className="flex items-center gap-3">
          <svg width="28" height="28" viewBox="0 0 24 24" aria-hidden="true" fill={color}>
            <path d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z" />
          </svg>
          <span className="text-2xl font-bold tracking-tight whitespace-nowrap" style={{ color }}>
            GitHub
          </span>
        </div>
      );
    },
  },
  {
    id: "stripe",
    label: "Stripe — payments infrastructure",
    render: () => (
      <div className="flex items-center gap-3">
        <svg width="22" height="28" viewBox="0 0 24 24" aria-hidden="true" fill="#635BFF">
          <path d="M13.976 9.15c-2.172-.806-3.356-1.426-3.356-2.409 0-.831.683-1.305 1.901-1.305 2.227 0 4.515.858 6.09 1.631l.89-5.494C18.252.975 15.697 0 12.165 0 9.667 0 7.589.654 6.104 1.872 4.56 3.147 3.757 4.992 3.757 7.218c0 4.039 2.467 5.76 6.476 7.219 2.585.92 3.445 1.574 3.445 2.583 0 .98-.84 1.545-2.354 1.545-1.875 0-4.965-.921-6.99-2.109l-.9 5.555C5.175 22.99 8.385 24 11.714 24c2.641 0 4.843-.624 6.328-1.813 1.664-1.305 2.525-3.236 2.525-5.732 0-4.128-2.524-5.851-6.591-7.305z" />
        </svg>
        <span
          className="text-2xl font-bold tracking-tight whitespace-nowrap"
          style={{ color: "#635BFF" }}
        >
          Stripe
        </span>
      </div>
    ),
  },
  {
    id: "react",
    label: "React — UI framework",
    render: (isDark) => {
      const color = isDark ? "#61DAFB" : "#0284c7";
      return (
        <div className="flex items-center gap-3">
          <svg
            width="28"
            height="28"
            viewBox="0 0 24 24"
            aria-hidden="true"
            fill="none"
            stroke={color}
            strokeWidth="1.4"
          >
            <circle cx="12" cy="12" r="2.05" fill={color} stroke="none" />
            <ellipse cx="12" cy="12" rx="10" ry="4" />
            <ellipse cx="12" cy="12" rx="10" ry="4" transform="rotate(60 12 12)" />
            <ellipse cx="12" cy="12" rx="10" ry="4" transform="rotate(120 12 12)" />
          </svg>
          <span className="text-2xl font-bold tracking-tight whitespace-nowrap" style={{ color }}>
            React
          </span>
        </div>
      );
    },
  },
  {
    id: "cloudflare",
    label: "Cloudflare — edge network and CDN",
    render: () => (
      <div className="flex items-center gap-3">
        <svg width="32" height="20" viewBox="0 0 200 130" aria-hidden="true">
          <path
            d="M148.3 68.4l2.8-9.5c.3-1.1.2-2.2-.3-3.1-.5-.9-1.4-1.5-2.5-1.7l-82.7-11.3c-.5-.1-1 .4-.8.9l.6 2.3c.1.5.6.8 1.1.7l81.7 11.2-.1.2-3.1 10.5c-.1.4.3.8.7.7l2.6-.5c.1 0 .2-.2.2-.4z"
            fill="#F6821F"
          />
          <path
            d="M152.5 51.2c-.5 0-1 .3-1.3.7l-3 10.2-.1.4-78.3-11c-.5-.1-1 .4-.8.9l.6 2.3c.1.5.6.8 1.1.7l78.3 11-.1.2-3.1 10.5c-.1.4.3.8.7.7l2.6-.5c.3-.1.5-.3.5-.6l3.1-10.5.1-.2 2.6.4c.5.1 1-.3 1-.8l.1-2.4c0-.8-.7-2.3-3.9-2.3z"
            fill="#FBAD41"
          />
          <circle cx="44" cy="92" r="20" fill="#F6821F" />
          <circle cx="170" cy="56" r="18" fill="#F6821F" />
        </svg>
        <span
          className="text-2xl font-bold tracking-tight whitespace-nowrap"
          style={{ color: "#F6821F" }}
        >
          Cloudflare
        </span>
      </div>
    ),
  },
  {
    id: "microsoft",
    label: "Microsoft — cloud and developer tools",
    render: () => (
      <div className="flex items-center gap-3">
        <svg width="28" height="28" viewBox="0 0 21 21" aria-hidden="true">
          <rect x="0" y="0" width="10" height="10" fill="#f25022" />
          <rect x="11" y="0" width="10" height="10" fill="#7fba00" />
          <rect x="0" y="11" width="10" height="10" fill="#00a4ef" />
          <rect x="11" y="11" width="10" height="10" fill="#ffb900" />
        </svg>
        <span
          className="text-2xl font-bold tracking-tight whitespace-nowrap"
          style={{ color: "#00a4ef" }}
        >
          Microsoft
        </span>
      </div>
    ),
  },
  {
    id: "expo",
    label: "Expo — cross-platform mobile development",
    render: (isDark) => {
      const color = isDark ? "#ffffff" : "#000020";
      return (
        <div className="flex items-center gap-3">
          <svg width="28" height="28" viewBox="0 0 128 128" aria-hidden="true" fill={color}>
            <path d="M64 0C28.654 0 0 28.654 0 64s28.654 64 64 64 64-28.654 64-64S99.346 0 64 0zm-4.5 96.5c-1.1 1.9-3.5 2.5-5.4 1.4L19.5 75.4c-1.9-1.1-2.5-3.5-1.4-5.4l26-45c1.1-1.9 3.5-2.5 5.4-1.4l35.6 20.6c1.9 1.1 2.5 3.5 1.4 5.4l-4.5 7.8c-1.1 1.9-3.5 2.5-5.4 1.4L58.6 50.3 40.9 80.9l18.1 10.4 9-15.6c.6-1 1.7-1.6 2.9-1.6H84c2.2 0 3.8 2.3 3 4.4L76.7 97c-.4 1-1.4 1.7-2.5 1.7H61.5c-1 0-1.9-.5-2.5-1.4L59.5 96.5z" />
          </svg>
          <span className="text-2xl font-bold tracking-tight whitespace-nowrap" style={{ color }}>
            Expo
          </span>
        </div>
      );
    },
  },
  {
    id: "postgresql",
    label: "PostgreSQL — relational database",
    render: () => (
      <div className="flex items-center gap-3">
        <svg width="28" height="28" viewBox="0 0 32 32" aria-hidden="true">
          <path
            d="M23.5 5.5c-1.4-.3-2.9-.1-4.2.5-1.4-1.1-3-1.7-4.8-1.7-1.1 0-2.2.3-3.2.8C8.7 3.7 5.4 4 3.5 6c-2 2-2.2 5.4-.7 8.5-.9 2.5-.9 5.1.1 7 .8 1.6 2.2 2.7 3.9 2.9.5 2.4 2.7 4.1 5.1 4.1.8 0 1.6-.2 2.3-.6.5.3 1 .5 1.6.5 1.1 0 2.2-.5 3-1.4 1.5.1 3-.5 4-1.6 1.2-1.3 1.6-3.2 1.1-5-.1-.3-.2-.6-.3-.9.3-.4.5-.9.7-1.4 1.4-3.7.6-7.9-1.8-10.5-.3-.3-.6-.7-1-1z"
            fill="#336791"
          />
          <ellipse cx="16" cy="12" rx="5" ry="6" fill="#fff" opacity="0.3" />
        </svg>
        <span
          className="text-2xl font-bold tracking-tight whitespace-nowrap"
          style={{ color: "#336791" }}
        >
          PostgreSQL
        </span>
      </div>
    ),
  },
  {
    id: "apple",
    label: "Apple — iOS and macOS platforms",
    render: (isDark) => {
      const color = isDark ? "#ffffff" : "#1d1d1f";
      return (
        <div className="flex items-center gap-3">
          <svg width="24" height="29" viewBox="0 0 814 1000" aria-hidden="true" fill={color}>
            <path d="M788.1 340.9c-5.8 4.5-108.2 62.2-108.2 190.5 0 148.4 130.3 200.9 134.2 202.2-.6 3.2-20.7 71.9-68.7 141.9-42.8 61.6-87.5 123.1-155.5 123.1s-85.5-39.5-164-39.5c-76.5 0-103.7 40.8-165.9 40.8s-105-57.8-155.5-127.4C46 790.8 0 663.3 0 541.8c0-207.9 135.4-318.1 268.5-318.1 100.5 0 184.4 66.2 247.3 66.2 60.7 0 155.9-70 272.1-70 28.5 0 130.9 2.6 198.3 99zM554.1 163c14.7-18.4 25.2-44.5 25.2-70.6 0-3.6-.3-7.3-.9-10.4-23.9 1-52.6 16.4-69.8 37.1-13.3 15.5-25.8 41.5-25.8 68.1 0 4 .6 7.9 1.2 10.8 1.8.3 4.8.6 7.9.6 21.3 0 48.2-14.3 62.2-35.6z" />
          </svg>
          <span className="text-2xl font-bold tracking-tight whitespace-nowrap" style={{ color }}>
            Apple
          </span>
        </div>
      );
    },
  },
  {
    id: "figma",
    label: "Figma — design and prototyping",
    render: () => (
      <div className="flex items-center gap-3">
        <svg width="18" height="28" viewBox="0 0 38 57" aria-hidden="true">
          <path d="M19 28.5a9.5 9.5 0 1 1 19 0 9.5 9.5 0 0 1-19 0z" fill="#1ABCFE" />
          <path d="M0 47.5A9.5 9.5 0 0 1 9.5 38H19v9.5a9.5 9.5 0 0 1-19 0z" fill="#0ACF83" />
          <path d="M19 0v19h9.5a9.5 9.5 0 0 0 0-19H19z" fill="#FF7262" />
          <path d="M0 9.5A9.5 9.5 0 0 0 9.5 19H19V0H9.5A9.5 9.5 0 0 0 0 9.5z" fill="#F24E1E" />
          <path d="M0 28.5A9.5 9.5 0 0 0 9.5 38H19V19H9.5A9.5 9.5 0 0 0 0 28.5z" fill="#A259FF" />
        </svg>
        <span
          className="text-2xl font-bold tracking-tight whitespace-nowrap"
          style={{ color: "#A259FF" }}
        >
          Figma
        </span>
      </div>
    ),
  },
  {
    id: "vercel",
    label: "Vercel — deployment and edge infrastructure",
    render: (isDark) => {
      const color = isDark ? "#ffffff" : "#000000";
      return (
        <div className="flex items-center gap-3">
          <svg width="26" height="22" viewBox="0 0 116 100" aria-hidden="true" fill={color}>
            <path d="M57.5 0L115 100H0L57.5 0z" />
          </svg>
          <span className="text-2xl font-bold tracking-tight whitespace-nowrap" style={{ color }}>
            Vercel
          </span>
        </div>
      );
    },
  },
  {
    id: "firebase",
    label: "Firebase — app backend platform",
    render: (isDark) => {
      const color = isDark ? "#FFCA28" : "#b45309";
      return (
        <div className="flex items-center gap-3">
          <svg width="22" height="30" viewBox="0 0 192 256" aria-hidden="true">
            <path d="M0 190.9L2.6 186l44.3-86.3L66.5 139l-24.2 47.2L0 190.9z" fill="#FFA000" />
            <path d="M112.5 190.9l2.5-4.9L68.6 92.8 56.5 139.7 112.5 190.9z" fill="#F57F17" />
            <path
              d="M168 215l2.4-4.7-25.8-50.2-32.6-29.4-64.2 59.2L168 215z"
              fill={isDark ? "#FFCA28" : "#F9A825"}
            />
          </svg>
          <span className="text-2xl font-bold tracking-tight whitespace-nowrap" style={{ color }}>
            Firebase
          </span>
        </div>
      );
    },
  },
  {
    id: "android",
    label: "Android — mobile platform",
    render: (isDark) => {
      const color = isDark ? "#3DDC84" : "#16a34a";
      return (
        <div className="flex items-center gap-3">
          <svg width="28" height="28" viewBox="0 0 24 24" aria-hidden="true" fill={color}>
            <path d="M17.523 15.341a.88.88 0 01-.878-.88.878.878 0 111.757 0 .88.88 0 01-.879.88m-11.047 0a.88.88 0 01-.879-.88.878.878 0 111.757 0 .88.88 0 01-.878.88m11.4-6.461l1.757-3.044a.366.366 0 00-.134-.499.365.365 0 00-.499.134l-1.779 3.082a11.13 11.13 0 00-4.32-.875c-1.544 0-3.006.312-4.32.875L6.9 5.471a.365.365 0 00-.499-.134.366.366 0 00-.134.499l1.756 3.044A10.415 10.415 0 002.11 15h19.78a10.415 10.415 0 00-3.915-6.12" />
          </svg>
          <span className="text-2xl font-bold tracking-tight whitespace-nowrap" style={{ color }}>
            Android
          </span>
        </div>
      );
    },
  },
];

const SEPARATOR = (
  <span className="text-muted-foreground/25 text-3xl font-thin select-none px-2" aria-hidden="true">
    /
  </span>
);

function TickerTrack({
  brands,
  isDark,
  reduced,
}: {
  brands: Brand[];
  isDark: boolean;
  reduced: boolean;
}) {
  const doubled = [...brands, ...brands];

  if (reduced) {
    return (
      <div className="flex flex-wrap gap-x-10 gap-y-4 px-6 justify-center">
        {brands.map((b) => (
          <div key={b.id} aria-label={b.label}>
            {b.render(isDark)}
          </div>
        ))}
      </div>
    );
  }

  return (
    <div
      className="relative flex overflow-hidden"
      style={{
        maskImage:
          "linear-gradient(to right, transparent 0%, black 10%, black 90%, transparent 100%)",
        WebkitMaskImage:
          "linear-gradient(to right, transparent 0%, black 10%, black 90%, transparent 100%)",
      }}
    >
      <div
        className="flex items-center"
        style={{
          animation: "ticker-left 40s linear infinite",
          willChange: "transform",
        }}
        onMouseEnter={(e) => {
          (e.currentTarget as HTMLDivElement).style.animationPlayState = "paused";
        }}
        onMouseLeave={(e) => {
          (e.currentTarget as HTMLDivElement).style.animationPlayState = "running";
        }}
      >
        {doubled.map((b, i) => (
          <div
            key={`${b.id}-${i}`}
            className="flex items-center"
            aria-label={i < brands.length ? b.label : undefined}
            aria-hidden={i >= brands.length ? true : undefined}
          >
            <div className="px-8 py-4 opacity-75 hover:opacity-100 transition-opacity duration-200">
              {b.render(isDark)}
            </div>
            {SEPARATOR}
          </div>
        ))}
      </div>
    </div>
  );
}

export function TechnologyEcosystemBanner() {
  const isDark = useIsDark();
  const [reduced, setReduced] = useState(false);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduced(mq.matches);
    const handler = (e: MediaQueryListEvent) => setReduced(e.matches);
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);

  return (
    <section aria-label="Technology ecosystem" className="w-full py-12 overflow-hidden">
      <div className="text-center mb-10 px-6">
        <p className="text-sm text-muted-foreground/70 max-w-xl mx-auto tracking-wide">
          Build with the technologies and ecosystems your apps already depend on
        </p>
      </div>

      <TickerTrack brands={BRANDS} isDark={isDark} reduced={reduced} />

      <p className="text-center text-[10px] text-muted-foreground/40 mt-8 px-6">
        Third-party logos and trademarks belong to their respective owners. Displayed for
        compatibility and ecosystem reference only.
      </p>
    </section>
  );
}
