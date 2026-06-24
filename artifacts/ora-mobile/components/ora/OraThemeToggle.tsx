import { Moon, Sun } from "lucide-react-native";
import React from "react";
import { Pressable } from "react-native";

import { useTheme } from "@/context/ThemeContext";
import { useColors } from "@/hooks/useColors";

/**
 * OraThemeToggle — native mirror of the website's `ThemeToggle`
 * (artifacts/mustaflow/src/components/theme-toggle.tsx).
 *
 * A round, bordered button that lives in the Ora header. It shows a Sun while
 * dark (tap to switch to light) and a Moon while light (tap to switch to dark),
 * exactly like the website. Tapping sets an explicit light/dark override; the
 * "System" option remains available in Settings, so the phone-system default is
 * preserved until the user chooses otherwise.
 */
export function OraThemeToggle() {
  const c = useColors();
  const { effectiveScheme, setThemeOverride } = useTheme();
  const isDark = effectiveScheme === "dark";

  return (
    <Pressable
      onPress={() => void setThemeOverride(isDark ? "light" : "dark")}
      hitSlop={8}
      accessibilityRole="button"
      accessibilityLabel={isDark ? "Switch to light mode" : "Switch to dark mode"}
      style={{
        width: 36,
        height: 36,
        borderRadius: 18,
        alignItems: "center",
        justifyContent: "center",
        borderWidth: 1,
        borderColor: c.border,
        backgroundColor: c.card,
      }}
    >
      {isDark ? (
        <Sun size={16} color={c.mutedForeground} />
      ) : (
        <Moon size={16} color={c.mutedForeground} />
      )}
    </Pressable>
  );
}
