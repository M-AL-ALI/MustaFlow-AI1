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

type SecondFactorStrategy = "totp" | "phone_code" | "email_code" | "backup_code";

type VerifyState =
  | {
      kind: "second_factor";
      strategy: SecondFactorStrategy;
      title: string;
      instructions: string;
      canResend: boolean;
    }
  | {
      kind: "first_factor" | "client_trust";
      strategy: "email_code";
      title: string;
      instructions: string;
      canResend: boolean;
    };

export default function SignInScreen() {
  const c = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { signIn, errors, fetchStatus } = useSignIn();
  const { startSSOFlow } = useSSO();

  const [emailAddress, setEmailAddress] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [verify, setVerify] = useState<VerifyState | null>(null);
  const [ssoLoading, setSsoLoading] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    if (Platform.OS !== "android") return;
    void WebBrowser.warmUpAsync();
    return () => void WebBrowser.coolDownAsync();
  }, []);

  const finishSignIn = useCallback(async () => {
    const { error } = await signIn.finalize({ navigate: () => router.replace("/") });
    if (error) setFormError("We couldn't complete sign-in. Please try again.");
  }, [signIn, router]);

  const setupSecondFactor = useCallback(async () => {
    const factors = signIn.supportedSecondFactors ?? [];
    const has = (s: SecondFactorStrategy) => factors.some((f) => f.strategy === s);

    if (has("totp")) {
      setVerify({
        kind: "second_factor",
        strategy: "totp",
        title: "Two-step verification",
        instructions: "Enter the 6-digit code from your authenticator app.",
        canResend: false,
      });
      return;
    }
    if (has("phone_code")) {
      const { error } = await signIn.mfa.sendPhoneCode();
      if (error) {
        setFormError("We couldn't send a verification code. Please try again.");
        return;
      }
      setVerify({
        kind: "second_factor",
        strategy: "phone_code",
        title: "Two-step verification",
        instructions: "Enter the code we texted to your phone.",
        canResend: true,
      });
      return;
    }
    if (has("email_code")) {
      const { error } = await signIn.mfa.sendEmailCode();
      if (error) {
        setFormError("We couldn't send a verification code. Please try again.");
        return;
      }
      setVerify({
        kind: "second_factor",
        strategy: "email_code",
        title: "Two-step verification",
        instructions: "Enter the code we emailed you.",
        canResend: true,
      });
      return;
    }
    if (has("backup_code")) {
      setVerify({
        kind: "second_factor",
        strategy: "backup_code",
        title: "Enter a backup code",
        instructions:
          "Enter one of the backup codes you saved when setting up two-step verification.",
        canResend: false,
      });
      return;
    }
    setFormError(
      "Your account needs a verification method that isn't supported in the app yet. Please sign in on the website.",
    );
  }, [signIn]);

  const setupEmailVerification = useCallback(
    async (kind: "first_factor" | "client_trust") => {
      const { error } = await signIn.emailCode.sendCode();
      if (error) {
        setFormError("We couldn't send a verification code. Please try again.");
        return;
      }
      setVerify({
        kind,
        strategy: "email_code",
        title: "Verify it's you",
        instructions: `Enter the code we emailed to ${emailAddress || "your email address"}.`,
        canResend: true,
      });
    },
    [signIn, emailAddress],
  );

  const routeAfterFactor = useCallback(async () => {
    switch (signIn.status) {
      case "complete":
        await finishSignIn();
        return;
      case "needs_second_factor":
        await setupSecondFactor();
        return;
      case "needs_first_factor":
        await setupEmailVerification("first_factor");
        return;
      case "needs_client_trust":
        await setupEmailVerification("client_trust");
        return;
      case "needs_new_password":
        setFormError(
          "Your password needs to be reset. Please reset it on the website, then sign in again.",
        );
        return;
      default:
        setFormError(
          "Additional verification is required. Please finish signing in on the website.",
        );
    }
  }, [signIn, finishSignIn, setupSecondFactor, setupEmailVerification]);

  const handleSubmit = useCallback(async () => {
    setFormError(null);
    const { error } = await signIn.password({ emailAddress, password });
    if (error) {
      setFormError("That email or password didn't work. Please try again.");
      return;
    }
    await routeAfterFactor();
  }, [signIn, emailAddress, password, routeAfterFactor]);

  const handleVerify = useCallback(async () => {
    if (!verify) return;
    setFormError(null);
    let error: unknown = null;
    if (verify.kind === "second_factor") {
      switch (verify.strategy) {
        case "totp":
          ({ error } = await signIn.mfa.verifyTOTP({ code }));
          break;
        case "phone_code":
          ({ error } = await signIn.mfa.verifyPhoneCode({ code }));
          break;
        case "email_code":
          ({ error } = await signIn.mfa.verifyEmailCode({ code }));
          break;
        case "backup_code":
          ({ error } = await signIn.mfa.verifyBackupCode({ code }));
          break;
      }
    } else {
      ({ error } = await signIn.emailCode.verifyCode({ code }));
    }
    if (error) {
      setFormError("That code wasn't valid. Please try again.");
      return;
    }
    setCode("");
    await routeAfterFactor();
  }, [verify, signIn, code, routeAfterFactor]);

  const handleResend = useCallback(async () => {
    if (!verify || !verify.canResend) return;
    setFormError(null);
    let error: unknown = null;
    if (verify.kind === "second_factor") {
      if (verify.strategy === "phone_code") ({ error } = await signIn.mfa.sendPhoneCode());
      else if (verify.strategy === "email_code") ({ error } = await signIn.mfa.sendEmailCode());
    } else {
      ({ error } = await signIn.emailCode.sendCode());
    }
    if (error) setFormError("We couldn't resend the code. Please try again in a moment.");
  }, [verify, signIn]);

  const handleStartOver = useCallback(async () => {
    setFormError(null);
    setCode("");
    setVerify(null);
    await signIn.reset();
  }, [signIn]);

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

          {verify ? (
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
                  {verify.title}
                </Text>
                <Text
                  style={{
                    color: c.mutedForeground,
                    fontFamily: "Inter_400Regular",
                    fontSize: 15,
                    textAlign: "center",
                  }}
                >
                  {verify.instructions}
                </Text>
              </View>

              <TextField
                label={verify.strategy === "backup_code" ? "Backup code" : "Verification code"}
                keyboardType={verify.strategy === "backup_code" ? "default" : "number-pad"}
                autoCapitalize="none"
                value={code}
                onChangeText={setCode}
                placeholder={verify.strategy === "backup_code" ? "Enter backup code" : "123456"}
              />

              {formError && <Text style={{ color: c.destructive, fontSize: 13 }}>{formError}</Text>}

              <Button
                label="Verify & continue"
                onPress={handleVerify}
                loading={fetchStatus === "fetching"}
                disabled={!code}
                full
              />

              {verify.canResend && (
                <Button label="Resend code" variant="ghost" onPress={handleResend} full />
              )}
              <Button
                label="Use a different account"
                variant="ghost"
                onPress={handleStartOver}
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
            </>
          )}
        </ScrollView>
      </KeyboardAvoidingView>
    </View>
  );
}
