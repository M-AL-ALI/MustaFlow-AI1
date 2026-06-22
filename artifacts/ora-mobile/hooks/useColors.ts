import { useTheme } from "@/context/ThemeContext";
import colors from "@/constants/colors";

/**
 * Returns the design tokens for the current color scheme.
 *
 * Reads the user's theme preference from ThemeContext (system / light / dark).
 * Falls back to dark when no preference is stored (first install).
 * The ThemeProvider in _layout.tsx handles persistence via AsyncStorage.
 */
export function useColors() {
  const { effectiveScheme } = useTheme();
  const palette = effectiveScheme === "dark" ? colors.dark : colors.light;
  return { ...palette, radius: colors.radius };
}
