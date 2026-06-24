import { Image } from "expo-image";
import React from "react";
import { View } from "react-native";

import { useColors } from "@/hooks/useColors";

/**
 * OraMenuLogo — native mirror of the website's Ora sidebar toggle button
 * (artifacts/mustaflow/src/components/layout/ora-sidebar.tsx, the fixed
 * top-left "Open Ora menu" button).
 *
 * On the website the menu is opened by a small rounded-xl chip showing the
 * MustaFlow logo — not a hamburger. This renders that same chip so the Ora
 * screen's drawer-open control matches the website. It is a plain View; the
 * surrounding ScreenHeader Pressable owns the openDrawer press.
 */
export function OraMenuLogo() {
  const c = useColors();

  return (
    <View
      style={{
        width: 36,
        height: 36,
        borderRadius: 12,
        alignItems: "center",
        justifyContent: "center",
        borderWidth: 1,
        borderColor: c.border,
        backgroundColor: c.sidebar,
        shadowColor: "#000",
        shadowOpacity: 0.12,
        shadowRadius: 4,
        shadowOffset: { width: 0, height: 2 },
        elevation: 3,
      }}
    >
      <Image
        source={require("@/assets/mustaflow-logo.png")}
        style={{ width: 24, height: 24 }}
        contentFit="contain"
      />
    </View>
  );
}
