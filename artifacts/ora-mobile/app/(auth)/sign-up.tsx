import { useAuth, useSignUp, useSSO } from "@clerk/expo";
import * as AuthSession from "expo-auth-session";
import { Link, useRouter } from "expo-router";
import * as WebBrowser from "expo-web-browser";
import React, { useCallback, useEffect, useState } from "react";
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Logo } from "@/components/Logo";
import { Button, TextField } from "@/components/ui";
import { useColors } from "@/hooks/useColors";

WebBrowser.maybeCompleteAuthSession();

export default function SignUpScreen() {
  const c = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { signUp, errors, fetchStatus } = useSignUp();
  const { isSignedIn } = useAuth();
  const { startSSOFlow } = useSSO();

  const [emailAddress, setEmailAddress] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [ssoLoading, setSsoLoading] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    if (Platform.OS !== "android") return;
    void WebBrowser.warmUpAsync();
    return () => void WebBrowser.coolDownAsync();
  }, []);

  const handleSubmit = useCallback(async () => {
    setFormError(null);
    const { error } = await signUp.password({ emailAddress, password });
    if (error) {
      setFormError("Couldn't create your account. Check your details and retry.");
      return;
    }
    await signUp.verifications.sendEmailCode();
  }, [signUp, emailAddress, password]);

  const handleVerify = useCallback(async () => {
    setFormError(null);
    await signUp.verifications.verifyEmailCode({ code });
    if (signUp.status === "complete") {
      await signUp.finalize({ navigate: () => router.replace("/") });
    } else {
      setFormError("That code wasn't valid. Please try again.");
    }
  }, [signUp, code, router]);

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
      setFormError("Google sign-up was cancelled or failed.");
    } finally {
      setSsoLoading(false);
    }
  }, [startSSOFlow, router]);

  if (signUp.status === "complete" || isSignedIn) return null;

  const awaitingCode =
    signUp.status === "missing_requirements" &&
    signUp.unverifiedFields?.includes("email_address");

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

          {awaitingCode ? (
            <>
              <View style={{ gap: 4 }}>
                <Text
                  style={{
                    color: c.foreground,
                    fontFamily: "Inter_700Bold",
                    fontSize: 26,
                    textAlign: "center",
                  }}
                >
                  Verify your email
                </Text>
                <Text
                  style={{
                    color: c.mutedForeground,
                    fontSize: 15,
                    textAlign: "center",
                  }}
                >
                  Enter the code we sent to {emailAddress}
                </Text>
              </View>
              <TextField
                label="Verification code"
                keyboardType="number-pad"
                value={code}
                onChangeText={setCode}
                placeholder="123456"
              />
              {formError && (
                <Text style={{ color: c.destructive, fontSize: 13 }}>
                  {formError}
                </Text>
              )}
              <Button
                label="Verify & continue"
                onPress={handleVerify}
                loading={fetchStatus === "fetching"}
                disabled={!code}
                full
              />
              <Button
                label="Resend code"
                variant="ghost"
                onPress={() => signUp.verifications.sendEmailCode()}
                full
              />
            </>
          ) : (
            <>
              <View style={{ gap: 4 }}>
                <Text
                  style={{
                    color: c.foreground,
                    fontFamily: "Inter_700Bold",
                    fontSize: 26,
                    textAlign: "center",
                  }}
                >
                  Create your account
                </Text>
                <Text
                  style={{
                    color: c.mutedForeground,
                    fontSize: 15,
                    textAlign: "center",
                  }}
                >
                  Start exploring Ora in seconds
                </Text>
              </View>

              <Button
                label="Continue with Google"
                variant="secondary"
                onPress={handleGoogle}
                loading={ssoLoading}
                full
              />

              <View
                style={{ flexDirection: "row", alignItems: "center", gap: 12 }}
              >
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
                placeholder="At least 8 characters"
              />

              {(errors?.fields?.emailAddress?.message ||
                errors?.fields?.password?.message ||
                formError) && (
                <Text style={{ color: c.destructive, fontSize: 13 }}>
                  {errors?.fields?.emailAddress?.message ||
                    errors?.fields?.password?.message ||
                    formError}
                </Text>
              )}

              <Button
                label="Create account"
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
                  Already have an account?
                </Text>
                <Link href="/sign-in" asChild>
                  <Pressable>
                    <Text
                      style={{
                        color: c.accentForeground,
                        fontFamily: "Inter_600SemiBold",
                        fontSize: 14,
                      }}
                    >
                      Sign in
                    </Text>
                  </Pressable>
                </Link>
              </View>
            </>
          )}
          <View nativeID="clerk-captcha" />
        </ScrollView>
      </KeyboardAvoidingView>
    </View>
  );
}
