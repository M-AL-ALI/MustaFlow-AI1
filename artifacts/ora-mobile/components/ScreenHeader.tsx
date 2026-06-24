import { useNavigation } from "expo-router";
import { Menu, type LucideIcon } from "lucide-react-native";
import React from "react";
import { Pressable, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useColors } from "@/hooks/useColors";

export function ScreenHeader({
  title,
  titleNode,
  subtitle,
  right,
  rightIcon: RightIcon,
  onRightPress,
  leftNode,
}: {
  title: string;
  titleNode?: React.ReactNode;
  subtitle?: string;
  right?: React.ReactNode;
  rightIcon?: LucideIcon;
  onRightPress?: () => void;
  /**
   * Custom content for the drawer-open button (left of the title). When omitted
   * the default hamburger icon is used. The Ora screen passes the MustaFlow
   * logo chip here to match the website's logo-button menu toggle.
   */
  leftNode?: React.ReactNode;
}) {
  const c = useColors();
  const insets = useSafeAreaInsets();
  const navigation = useNavigation();

  return (
    <View
      style={{
        paddingTop: insets.top + 8,
        paddingBottom: 12,
        paddingHorizontal: 14,
        flexDirection: "row",
        alignItems: "center",
        gap: 12,
        borderBottomWidth: 1,
        borderBottomColor: c.border,
        backgroundColor: c.background,
      }}
    >
      <Pressable
        onPress={() => (navigation as unknown as { openDrawer: () => void }).openDrawer()}
        hitSlop={10}
        style={{ padding: 4 }}
        accessibilityRole="button"
        accessibilityLabel="Open Ora menu"
      >
        {leftNode ?? <Menu size={24} color={c.foreground} />}
      </Pressable>
      <View style={{ flex: 1 }}>
        {titleNode ?? (
          <Text
            numberOfLines={1}
            style={{
              color: c.foreground,
              fontFamily: "Inter_700Bold",
              fontSize: 18,
            }}
          >
            {title}
          </Text>
        )}
        {subtitle && (
          <Text numberOfLines={1} style={{ color: c.mutedForeground, fontSize: 12 }}>
            {subtitle}
          </Text>
        )}
      </View>
      {right}
      {RightIcon && onRightPress && (
        <Pressable onPress={onRightPress} hitSlop={10} style={{ padding: 4 }}>
          <RightIcon size={22} color={c.foreground} />
        </Pressable>
      )}
    </View>
  );
}
