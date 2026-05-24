import { useEffect, useState } from "react";
import { Moon, Sun } from "lucide-react";
import { applyTheme, getStoredTheme, THEME_EVENT, type AppearanceMode } from "@/lib/theme";
import { cn } from "@/lib/utils";

interface ThemeToggleProps {
  className?: string;
}

export function ThemeToggle({ className }: ThemeToggleProps) {
  const [mode, setMode] = useState<AppearanceMode>(() => getStoredTheme());

  useEffect(() => {
    const handler = () => setMode(getStoredTheme());
    window.addEventListener(THEME_EVENT, handler);
    return () => window.removeEventListener(THEME_EVENT, handler);
  }, []);

  const isDark = mode !== "light";

  const toggle = () => {
    const next: AppearanceMode = isDark ? "light" : "dark";
    applyTheme(next);
    setMode(next);
  };

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={isDark ? "Switch to light mode" : "Switch to dark mode"}
      title={isDark ? "Switch to light mode" : "Switch to dark mode"}
      className={cn(
        "inline-flex items-center justify-center h-9 w-9 rounded-full border border-border bg-card text-muted-foreground hover:text-foreground hover:bg-muted transition-colors",
        className,
      )}
    >
      {isDark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
    </button>
  );
}
