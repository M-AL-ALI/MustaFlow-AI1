import { Image } from "expo-image";
import React from "react";
import { Text, View } from "react-native";

const logo = require("@/assets/logo.png");

/** Ora wordmark. Uses the brand logo asset with a text fallback. */
export function Logo({
  size = 28,
  showWordmark = true,
  color = "#ffffff",
}: {
  size?: number;
  showWordmark?: boolean;
  color?: string;
}) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
      <Image
        source={logo}
        style={{ width: size, height: size }}
        contentFit="contain"
        transition={150}
      />
      {showWordmark && (
        <Text
          style={{
            color,
            fontFamily: "Inter_700Bold",
            fontSize: size * 0.62,
            letterSpacing: -0.4,
          }}
        >
          Ora
        </Text>
      )}
    </View>
  );
}
