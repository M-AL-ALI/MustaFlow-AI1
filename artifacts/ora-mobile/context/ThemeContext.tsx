import AsyncStorage from "@react-native-async-storage/async-storage";
import React, { createContext, useCallback, useContext, useEffect, useState } from "react";
import { useColorScheme } from "react-native";

export type ThemeOverride = "system" | "light" | "dark";

const STORAGE_KEY = "ora:themeOverride";

interface ThemeContextValue {
  themeOverride: ThemeOverride;
  setThemeOverride: (t: ThemeOverride) => Promise<void>;
  effectiveScheme: "light" | "dark";
}

const ThemeContext = createContext<ThemeContextValue>({
  themeOverride: "system",
  setThemeOverride: async () => {},
  effectiveScheme: "dark",
});

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const systemScheme = useColorScheme();
  const [themeOverride, setThemeOverrideState] = useState<ThemeOverride>("system");

  useEffect(() => {
    AsyncStorage.getItem(STORAGE_KEY)
      .then((val) => {
        if (val === "system" || val === "light" || val === "dark") {
          setThemeOverrideState(val);
        }
      })
      .catch(() => {});
  }, []);

  const setThemeOverride = useCallback(async (t: ThemeOverride) => {
    setThemeOverrideState(t);
    await AsyncStorage.setItem(STORAGE_KEY, t);
  }, []);

  const effectiveScheme: "light" | "dark" =
    themeOverride === "system" ? (systemScheme ?? "dark") : themeOverride;

  return (
    <ThemeContext.Provider value={{ themeOverride, setThemeOverride, effectiveScheme }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  return useContext(ThemeContext);
}
