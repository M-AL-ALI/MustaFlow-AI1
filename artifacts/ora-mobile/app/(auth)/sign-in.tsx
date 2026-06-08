import { useSignIn, useSSO } from "@clerk/expo";
import * as AuthSession from "expo-auth-session";
import { Link, useRouter } from "expo-router";
import * as WebBrowser from "expo-web-browser";
import React, { useCallback, useEffect, useState } from "react";
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Logo } from "@/components/Logo";
import { Button, TextField } from "@/components/ui";
import { useColors } from "@/hooks/useColors";

WebBrowser.maybeCompleteAuthSession();

export default function SignInScreen() {
  const c = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { signIn, errors, fetchStatus } = useSignIn();
  const { startSSOFlow } = useSSO();

  const [emailAddress, setEmailAddress] = useState("");
  const [password, setPassword] = useState("");
  const [ssoLoading, setSsoLoading] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    if (Platform.OS !== "android") return;
    void WebBrowser.warmUpAsync();
    return () => void WebBrowser.coolDownAsync();
  }, []);

  const handleSubmit = useCallback(async () => {
    setFormError(null);
    const { error } = await signIn.password({ emailAddress, password });
    if (error) {
      setFormError("That email or password didn't work. Please try again.");
      return;
    }
    if (signIn.status === "complete") {
      await signIn.finalize({
        navigate: () => router.replace("/"),
      });
    } else {
      setFormError("Additional verification is required to sign in.");
    }
  }, [signIn, emailAddress, password, router]);

  const handleGoogle = useCallback(async () => {
    try {
      setSsoLoading(true);
      const { createdSessionId, setActive } = await startSSOFlow({
        strategy: "oauth_google",
        redirectUrl: AuthSession.makeRedirectUri(),
      });
      if (createdSessionId && setActive) {
        await setActive({
          session: createdSessionId,
          navigate: () => router.replace("/"),
        });
      }
    } catch {
      setFormError("Google sign-in was cancelled or failed.");
    } finally {
      setSsoLoading(false);
    }
  }, [startSSOFlow, router]);

  const fieldErr =
    errors?.fields?.identifier?.message || errors?.fields?.password?.message || formError;

  return (
    <View style={{ flex: 1, backgroundColor: c.background }}>
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <ScrollView
          contentContainerStyle={{
            flexGrow: 1,
            justifyContent: "center",
            padding: 24,
            paddingTop: insets.top + 24,
            paddingBottom: insets.bottom + 24,
            gap: 18,
          }}
          keyboardShouldPersistTaps="handled"
        >
          <View style={{ alignItems: "center", marginBottom: 8 }}>
            <Logo size={40} />
          </View>
          <View style={{ gap: 4 }}>
            <Text
              style={{
                color: c.foreground,
                fontFamily: "Inter_700Bold",
                fontSize: 26,
                textAlign: "center",
              }}
            >
              Welcome back
            </Text>
            <Text
              style={{
                color: c.mutedForeground,
                fontFamily: "Inter_400Regular",
                fontSize: 15,
                textAlign: "center",
              }}
            >
              Sign in to continue to Ora
            </Text>
          </View>

          <Button
            label="Continue with Google"
            variant="secondary"
            onPress={handleGoogle}
            loading={ssoLoading}
            full
          />

          <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
            <View style={{ flex: 1, height: 1, backgroundColor: c.border }} />
            <Text style={{ color: c.mutedForeground, fontSize: 13 }}>or</Text>
            <View style={{ flex: 1, height: 1, backgroundColor: c.border }} />
          </View>

          <TextField
            label="Email address"
            autoCapitalize="none"
            autoComplete="email"
            keyboardType="email-address"
            value={emailAddress}
            onChangeText={setEmailAddress}
            placeholder="you@example.com"
          />
          <TextField
            label="Password"
            secureTextEntry
            value={password}
            onChangeText={setPassword}
            placeholder="Enter your password"
          />

          {fieldErr && (
            <Text
              style={{
                color: c.destructive,
                fontFamily: "Inter_400Regular",
                fontSize: 13,
              }}
            >
              {fieldErr}
            </Text>
          )}

          <Button
            label="Sign in"
            onPress={handleSubmit}
            loading={fetchStatus === "fetching"}
            disabled={!emailAddress || !password}
            full
          />

          <View
            style={{
              flexDirection: "row",
              justifyContent: "center",
              gap: 4,
              marginTop: 4,
            }}
          >
            <Text style={{ color: c.mutedForeground, fontSize: 14 }}>
              Don&apos;t have an account?
            </Text>
            <Link href="/sign-up" asChild>
              <Pressable>
                <Text
                  style={{
                    color: c.accentForeground,
                    fontFamily: "Inter_600SemiBold",
                    fontSize: 14,
                  }}
                >
                  Sign up
                </Text>
              </Pressable>
            </Link>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </View>
  );
}
