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
import React, { useEffect } from "react";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { KeyboardProvider } from "react-native-keyboard-controller";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { ErrorBoundary } from "@/components/ErrorBoundary";
import { logError } from "@/lib/log";
import { SafeAreaView } from "react-native-safe-area-context";
import { Text, View } from "react-native";

// Point the generated API client at the existing production API server.
// Fall back to the production domain so device builds always have a valid URL.
const domain = process.env.EXPO_PUBLIC_DOMAIN || "mustaflow.com";
setBaseUrl(`https://${domain}`);

// Same code runs in dev and prod; the env var is empty in dev (Clerk dev keys)
// and auto-populated in prod. Do NOT add NODE_ENV gates.
const publishableKey = process.env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY ?? "";
const proxyUrl = process.env.EXPO_PUBLIC_CLERK_PROXY_URL || undefined;

// Prevent the splash screen from auto-hiding before asset loading is complete.
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

export default function RootLayout() {
  const [fontsLoaded, fontError] = useFonts({
    Inter_400Regular,
    Inter_500Medium,
    Inter_600SemiBold,
    Inter_700Bold,
  });

  useEffect(() => {
    if (fontsLoaded || fontError) {
      // Give the dark splash ~1.5s of presence before revealing the app.
      const t = setTimeout(() => SplashScreen.hideAsync(), 1500);
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
    <ClerkProvider publishableKey={publishableKey} tokenCache={tokenCache} proxyUrl={proxyUrl}>
      <ClerkLoaded>
        <SafeAreaProvider>
          <ErrorBoundary
            onError={(error) => logError("error-boundary", "Unhandled render error", error)}
          >
            <QueryClientProvider client={queryClient}>
              <GestureHandlerRootView style={{ flex: 1 }}>
                <KeyboardProvider>
                  <StatusBar style="light" />
                  <RootLayoutNav />
                </KeyboardProvider>
              </GestureHandlerRootView>
            </QueryClientProvider>
          </ErrorBoundary>
        </SafeAreaProvider>
      </ClerkLoaded>
    </ClerkProvider>
  );
}
