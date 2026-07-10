import { useSSO } from "@clerk/expo";
import { useSignInWithApple } from "@clerk/expo/apple";
import * as AppleAuthentication from "expo-apple-authentication";
import * as AuthSession from "expo-auth-session";
import { useRouter } from "expo-router";
import React, { useCallback, useState } from "react";
import { Platform } from "react-native";

import { Button } from "@/components/ui";
import { useTheme } from "@/context/ThemeContext";
import { useColors } from "@/hooks/useColors";

function isUserCancellation(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code;
  if (code === "ERR_REQUEST_CANCELED" || code === "ERR_CANCELED") return true;
  const message = String((err as { message?: string } | null)?.message ?? "").toLowerCase();
  return message.includes("cancel");
}

/**
 * "Sign in with Apple" button wired into Clerk (App Store Guideline 4.8).
 *
 * On iOS it renders Apple's official button and runs the true native flow via
 * Clerk's `useSignInWithApple` (AppleAuthentication.signInAsync -> Clerk
 * oauth_token_apple, with automatic sign-up transfer for new users) — never a
 * web fallback. On other platforms it falls back to the OAuth web flow via
 * `useSSO` so prominence is kept everywhere the Google option appears.
 *
 * User cancellation is silent; only real Apple/Clerk failures surface via
 * `onError`.
 */
export function AppleSignInButton({
  label,
  onError,
}: {
  label: string;
  onError: (message: string) => void;
}) {
  const c = useColors();
  const { effectiveScheme } = useTheme();
  const router = useRouter();
  const { startSSOFlow } = useSSO();
  const { startAppleAuthenticationFlow } = useSignInWithApple();
  const [loading, setLoading] = useState(false);

  const handleApple = useCallback(async () => {
    if (loading) return;
    try {
      setLoading(true);
      const { createdSessionId, setActive } =
        Platform.OS === "ios"
          ? await startAppleAuthenticationFlow()
          : await startSSOFlow({
              strategy: "oauth_apple",
              redirectUrl: AuthSession.makeRedirectUri(),
            });
      if (createdSessionId && setActive) {
        await setActive({
          session: createdSessionId,
          navigate: () => router.replace("/"),
        });
      }
    } catch (err) {
      if (!isUserCancellation(err)) {
        onError("Apple sign-in failed. Please try again.");
      }
    } finally {
      setLoading(false);
    }
  }, [loading, startAppleAuthenticationFlow, startSSOFlow, router, onError]);

  if (Platform.OS === "ios") {
    return (
      <AppleAuthentication.AppleAuthenticationButton
        buttonType={AppleAuthentication.AppleAuthenticationButtonType.CONTINUE}
        buttonStyle={
          effectiveScheme === "dark"
            ? AppleAuthentication.AppleAuthenticationButtonStyle.WHITE
            : AppleAuthentication.AppleAuthenticationButtonStyle.BLACK
        }
        cornerRadius={c.radius}
        style={{ height: 48, alignSelf: "stretch" }}
        onPress={handleApple}
      />
    );
  }

  return <Button label={label} variant="secondary" onPress={handleApple} loading={loading} full />;
}
