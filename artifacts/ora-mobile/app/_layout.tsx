import { ClerkLoaded, ClerkProvider } from "@clerk/expo";
import { tokenCache } from "@clerk/expo/token-cache";
import {
  Inter_400Regular,
  Inter_500Medium,
  Inter_600SemiBold,
  Inter_700Bold,
  useFonts,
} from "@expo-google-fonts/inter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { setBaseUrl } from "@/lib/auth-client";
import { Stack } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import { StatusBar } from "expo-status-bar";
import React, { useCallback, useEffect, useState } from "react";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { KeyboardProvider } from "react-native-keyboard-controller";
import { SafeAreaProvider } from "react-native-safe-area-context";

import * as Sentry from "@sentry/react-native";

import { AnimatedSplash } from "@/components/AnimatedSplash";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { ThemeProvider, useTheme } from "@/context/ThemeContext";
import { logError } from "@/lib/log";
import { SafeAreaView } from "react-native-safe-area-context";
import { Text, View } from "react-native";

// Same convention as the website (VITE_SENTRY_DSN): no DSN means Sentry stays
// fully disabled, so dev/simulator runs never report.
const sentryDsn = process.env.EXPO_PUBLIC_SENTRY_DSN;
Sentry.init({
  dsn: sentryDsn,
  enabled: Boolean(sentryDsn),
  tracesSampleRate: 0.1,
  sendDefaultPii: false,
});

const domain = process.env.EXPO_PUBLIC_DOMAIN || "www.mustaflow.com";
setBaseUrl(`https://${domain}`);

const publishableKey = process.env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY ?? "";
const proxyUrl = process.env.EXPO_PUBLIC_CLERK_PROXY_URL || undefined;

SplashScreen.preventAutoHideAsync();

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, staleTime: 30_000 },
  },
});

function RootLayoutNav() {
  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="(home)" />
      <Stack.Screen name="(auth)" />
    </Stack>
  );
}

function ThemedStatusBar() {
  const { effectiveScheme } = useTheme();
  return <StatusBar style={effectiveScheme === "dark" ? "light" : "dark"} />;
}

function RootLayout() {
  const [fontsLoaded, fontError] = useFonts({
    Inter_400Regular,
    Inter_500Medium,
    Inter_600SemiBold,
    Inter_700Bold,
  });
  const [splashDone, setSplashDone] = useState(false);
  const handleSplashFinish = useCallback(() => setSplashDone(true), []);

  useEffect(() => {
    if (fontsLoaded || fontError) {
      // Hand off quickly from the static native splash to the animated JS splash
      // overlay (same dark bg + green atom) so the startup logo visibly moves.
      const t = setTimeout(() => {
        void SplashScreen.hideAsync().catch(() => {});
      }, 100);
      return () => clearTimeout(t);
    }
  }, [fontsLoaded, fontError]);

  if (!fontsLoaded && !fontError) return null;

  if (!publishableKey) {
    return (
      <SafeAreaView
        style={{
          flex: 1,
          backgroundColor: "#0a0a0a",
          alignItems: "center",
          justifyContent: "center",
          padding: 32,
        }}
      >
        <View style={{ gap: 12, alignItems: "center" }}>
          <Text style={{ color: "#ff4d4d", fontSize: 17, fontWeight: "700" }}>
            Configuration Error
          </Text>
          <Text style={{ color: "#888", fontSize: 14, textAlign: "center", lineHeight: 20 }}>
            EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY is missing.{"\n\n"}
            This build was not configured correctly. Please install a new build from TestFlight.
          </Text>
          <Text style={{ color: "#555", fontSize: 12, marginTop: 8 }}>API: {domain}</Text>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <ThemeProvider>
      <View style={{ flex: 1, backgroundColor: "#0a0a0a" }}>
        <ClerkProvider publishableKey={publishableKey} tokenCache={tokenCache} proxyUrl={proxyUrl}>
          <ClerkLoaded>
            <SafeAreaProvider>
              <ErrorBoundary
                onError={(error) => logError("error-boundary", "Unhandled render error", error)}
              >
                <QueryClientProvider client={queryClient}>
                  <GestureHandlerRootView style={{ flex: 1 }}>
                    <KeyboardProvider>
                      <ThemedStatusBar />
                      <RootLayoutNav />
                    </KeyboardProvider>
                  </GestureHandlerRootView>
                </QueryClientProvider>
              </ErrorBoundary>
            </SafeAreaProvider>
          </ClerkLoaded>
        </ClerkProvider>
        {!splashDone && <AnimatedSplash onFinish={handleSplashFinish} />}
      </View>
    </ThemeProvider>
  );
}

export default Sentry.wrap(RootLayout);
