---
name: react-vite
description: Build React + Vite + TypeScript + Tailwind apps with the standard MustaFlow structure.
triggers: [react, vite, tsx, tailwind, spa, single-page app, dashboard, web app]
---

# React + Vite skill

Use this skill whenever the user asks for a React, Vite, SPA, or TSX-based web
application. Generated apps must follow the project structure below exactly —
the build/preview pipeline depends on it.

## Required files

- `package.json` — pinned versions matching the system prompt.
- `vite.config.ts` — uses `@vitejs/plugin-react`. Read `PORT` from env when present, fall back to `5173`. Never hardcode a port.
- `tailwind.config.js` — `content: ["./index.html", "./src/**/*.{ts,tsx}"]`.
- `postcss.config.js` — `{ tailwindcss: {}, autoprefixer: {} }`.
- `index.html` — Vite entry, includes `<script type="module" src="/src/main.tsx"></script>`.
- `src/main.tsx` — `createRoot` + `<StrictMode>`.
- `src/App.tsx` — root component, sets up router for multi-page apps.
- `src/index.css` — `@tailwind base; @tailwind components; @tailwind utilities;`.

## Do

- TypeScript everywhere. Type props, hook return values, and API responses.
- Use `lucide-react` for every icon. No emoji.
- Mobile-first responsive layout using Tailwind breakpoints.
- Loading state + error state for every async fetch.
- Read env vars via `import.meta.env.VITE_*`. Never hardcode keys.
- Use semantic HTML (`<header>`, `<main>`, `<button>`, `<label for>`) and add `aria-label` to icon-only buttons.

## Don't

- No CRA conventions (`%PUBLIC_URL%`, `process.env.REACT_APP_*`).
- No CSS-in-JS libraries. Tailwind utilities only — handwritten CSS only when truly necessary.
- No `any` types. No `// @ts-ignore`.
- No emojis in copy.
- No global state libraries for trivial apps; use `useState` / `useReducer` first, escalate to context only when shared.

## Example component pattern

```tsx
import { Sparkles } from "lucide-react";

type ButtonProps = {
  label: string;
  onClick: () => void;
  variant?: "primary" | "ghost";
};

export function Button({ label, onClick, variant = "primary" }: ButtonProps) {
  const base = "inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium";
  const styles =
    variant === "primary"
      ? "bg-indigo-600 text-white hover:bg-indigo-500"
      : "bg-transparent text-slate-200 hover:bg-slate-800";
  return (
    <button type="button" onClick={onClick} className={`${base} ${styles}`}>
      <Sparkles className="h-4 w-4" aria-hidden="true" />
      <span>{label}</span>
    </button>
  );
}
```
