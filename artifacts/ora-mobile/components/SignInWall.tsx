import { useRouter } from "expo-router";
import { LogIn } from "lucide-react-native";
import React from "react";
import { Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Button } from "@/components/ui";
import { useColors } from "@/hooks/useColors";

interface Props {
  title?: string;
  description?: string;
}

export function SignInWall({
  title = "Sign in required",
  description = "Sign in to access this feature.",
}: Props) {
  const c = useColors();
  const router = useRouter();
  const insets = useSafeAreaInsets();

  return (
    <View
      style={{
        flex: 1,
        alignItems: "center",
        justifyContent: "center",
        paddingHorizontal: 32,
        paddingBottom: insets.bottom + 24,
      }}
    >
      <View
        style={{
          width: 64,
          height: 64,
          borderRadius: 32,
          backgroundColor: c.muted,
          alignItems: "center",
          justifyContent: "center",
          marginBottom: 20,
        }}
      >
        <LogIn size={28} color={c.mutedForeground} />
      </View>
      <Text
        style={{
          color: c.foreground,
          fontFamily: "Inter_600SemiBold",
          fontSize: 18,
          textAlign: "center",
          marginBottom: 10,
        }}
      >
        {title}
      </Text>
      <Text
        style={{
          color: c.mutedForeground,
          fontSize: 14,
          textAlign: "center",
          marginBottom: 28,
          lineHeight: 22,
        }}
      >
        {description}
      </Text>
      <Button label="Sign in" onPress={() => router.push("/sign-in")} />
    </View>
  );
}
