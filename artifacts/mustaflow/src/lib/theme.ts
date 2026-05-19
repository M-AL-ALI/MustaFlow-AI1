export type AppearanceMode = "dark" | "light" | "system";

const STORAGE_KEY = "mf_appearance";
export const THEME_EVENT = "mf-theme-change";

/** Apply the correct dark/light class to <html> without dispatching any event. */
export function syncThemeDom(mode: AppearanceMode): void {
  const root = document.documentElement;
  if (mode === "light") {
    root.classList.remove("dark");
  } else if (mode === "system") {
    const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    if (prefersDark) {
      root.classList.add("dark");
    } else {
      root.classList.remove("dark");
    }
  } else {
    root.classList.add("dark");
  }
}

/**
 * Persist mode to localStorage, apply DOM class, and dispatch THEME_EVENT so
 * other components (e.g. Settings UI) can react. Do NOT call this inside a
 * THEME_EVENT listener — use syncThemeDom instead to avoid recursion.
 */
export function applyTheme(mode: AppearanceMode): void {
  localStorage.setItem(STORAGE_KEY, mode);
  syncThemeDom(mode);
  window.dispatchEvent(new CustomEvent(THEME_EVENT));
}

export function getStoredTheme(): AppearanceMode {
  return (localStorage.getItem(STORAGE_KEY) as AppearanceMode) ?? "dark";
}
