import { LucideIcon } from "lucide-react-native";
import React from "react";
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  TextInputProps,
  View,
  ViewStyle,
} from "react-native";

import { useColors } from "@/hooks/useColors";

type ButtonVariant = "primary" | "secondary" | "ghost" | "destructive";

export function Button({
  label,
  onPress,
  variant = "primary",
  loading,
  disabled,
  icon: Icon,
  style,
  full,
}: {
  label: string;
  onPress?: () => void;
  variant?: ButtonVariant;
  loading?: boolean;
  disabled?: boolean;
  icon?: LucideIcon;
  style?: ViewStyle;
  full?: boolean;
}) {
  const c = useColors();
  const isDisabled = disabled || loading;

  const bg: Record<ButtonVariant, string> = {
    primary: c.primary,
    secondary: c.secondary,
    ghost: "transparent",
    destructive: c.destructive,
  };
  const fg: Record<ButtonVariant, string> = {
    primary: c.primaryForeground,
    secondary: c.secondaryForeground,
    ghost: c.foreground,
    destructive: c.destructiveForeground,
  };

  return (
    <Pressable
      onPress={onPress}
      disabled={isDisabled}
      style={({ pressed }) => [
        {
          backgroundColor: bg[variant],
          borderRadius: c.radius,
          paddingVertical: 13,
          paddingHorizontal: 18,
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "center",
          gap: 8,
          borderWidth: variant === "ghost" ? 1 : 0,
          borderColor: c.border,
          opacity: isDisabled ? 0.5 : pressed ? 0.85 : 1,
          alignSelf: full ? "stretch" : undefined,
        },
        style,
      ]}
    >
      {loading ? (
        <ActivityIndicator color={fg[variant]} size="small" />
      ) : (
        <>
          {Icon && <Icon size={18} color={fg[variant]} />}
          <Text
            style={{
              color: fg[variant],
              fontFamily: "Inter_600SemiBold",
              fontSize: 15,
            }}
          >
            {label}
          </Text>
        </>
      )}
    </Pressable>
  );
}

export function TextField({ label, style, ...props }: TextInputProps & { label?: string }) {
  const c = useColors();
  return (
    <View style={{ gap: 6 }}>
      {label && (
        <Text
          style={{
            color: c.mutedForeground,
            fontFamily: "Inter_500Medium",
            fontSize: 13,
          }}
        >
          {label}
        </Text>
      )}
      <TextInput
        placeholderTextColor={c.mutedForeground}
        style={[
          {
            backgroundColor: c.card,
            borderWidth: 1,
            borderColor: c.border,
            borderRadius: c.radius,
            paddingHorizontal: 14,
            paddingVertical: 12,
            color: c.foreground,
            fontFamily: "Inter_400Regular",
            fontSize: 15,
          },
          style,
        ]}
        {...props}
      />
    </View>
  );
}

export function Card({ children, style }: { children: React.ReactNode; style?: ViewStyle }) {
  const c = useColors();
  return (
    <View
      style={[
        {
          backgroundColor: c.card,
          borderWidth: 1,
          borderColor: c.cardBorder,
          borderRadius: c.radius,
          padding: 16,
        },
        style,
      ]}
    >
      {children}
    </View>
  );
}

export function Pill({
  label,
  active,
  onPress,
  icon: Icon,
}: {
  label: string;
  active?: boolean;
  onPress?: () => void;
  icon?: LucideIcon;
}) {
  const c = useColors();
  return (
    <Pressable
      onPress={onPress}
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 6,
        paddingHorizontal: 12,
        paddingVertical: 7,
        borderRadius: 999,
        backgroundColor: active ? c.primary : c.secondary,
        borderWidth: 1,
        borderColor: active ? c.primary : c.border,
      }}
    >
      {Icon && <Icon size={14} color={active ? c.primaryForeground : c.mutedForeground} />}
      <Text
        style={{
          color: active ? c.primaryForeground : c.foreground,
          fontFamily: "Inter_500Medium",
          fontSize: 13,
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}

export function EmptyState({
  icon: Icon,
  title,
  subtitle,
}: {
  icon: LucideIcon;
  title: string;
  subtitle?: string;
}) {
  const c = useColors();
  return (
    <View style={{ alignItems: "center", paddingVertical: 48, gap: 10 }}>
      <View
        style={{
          width: 56,
          height: 56,
          borderRadius: 16,
          backgroundColor: c.secondary,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <Icon size={26} color={c.mutedForeground} />
      </View>
      <Text
        style={{
          color: c.foreground,
          fontFamily: "Inter_600SemiBold",
          fontSize: 16,
          textAlign: "center",
        }}
      >
        {title}
      </Text>
      {subtitle && (
        <Text
          style={{
            color: c.mutedForeground,
            fontFamily: "Inter_400Regular",
            fontSize: 14,
            textAlign: "center",
            maxWidth: 280,
            lineHeight: 20,
          }}
        >
          {subtitle}
        </Text>
      )}
    </View>
  );
}

export function Loading({ label }: { label?: string }) {
  const c = useColors();
  return (
    <View style={{ paddingVertical: 48, alignItems: "center", gap: 12 }}>
      <ActivityIndicator color={c.primary} />
      {label && (
        <Text
          style={{
            color: c.mutedForeground,
            fontFamily: "Inter_400Regular",
            fontSize: 14,
          }}
        >
          {label}
        </Text>
      )}
    </View>
  );
}

export const sharedStyles = StyleSheet.create({
  screen: { flex: 1 },
  sectionTitle: {
    fontFamily: "Inter_700Bold",
    fontSize: 18,
  },
  body: {
    fontFamily: "Inter_400Regular",
    fontSize: 14,
    lineHeight: 20,
  },
});
