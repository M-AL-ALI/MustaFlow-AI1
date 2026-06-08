import { useAuth, useUser } from "@clerk/expo";
import { setAuthTokenGetter } from "@workspace/api-client-react";
import {
  DrawerContentScrollView,
  DrawerContentComponentProps,
} from "@react-navigation/drawer";
import { Redirect, useRouter } from "expo-router";
import { Drawer } from "expo-router/drawer";
import {
  BookOpen,
  Brain,
  HelpCircle,
  LogOut,
  type LucideIcon,
  MessageSquare,
  Settings,
  TerminalSquare,
} from "lucide-react-native";
import React, { useEffect } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Logo } from "@/components/Logo";
import { useColors } from "@/hooks/useColors";

const NAV: { name: string; label: string; icon: LucideIcon }[] = [
  { name: "index", label: "Ora", icon: MessageSquare },
  { name: "orax", label: "Orax", icon: TerminalSquare },
  { name: "memory", label: "Memory", icon: Brain },
  { name: "library", label: "Library", icon: BookOpen },
  { name: "settings", label: "Settings", icon: Settings },
  { name: "help", label: "Help", icon: HelpCircle },
];

function CustomDrawer(props: DrawerContentComponentProps) {
  const c = useColors();
  const insets = useSafeAreaInsets();
  const { signOut } = useAuth();
  const { user } = useUser();
  const router = useRouter();

  const activeRoute = props.state.routeNames[props.state.index];

  return (
    <View style={{ flex: 1, backgroundColor: c.sidebar }}>
      <DrawerContentScrollView
        {...props}
        contentContainerStyle={{ paddingTop: insets.top + 8 }}
      >
        <View style={{ paddingHorizontal: 16, paddingBottom: 18 }}>
          <Logo size={30} />
        </View>

        <View style={{ paddingHorizontal: 10, gap: 4 }}>
          {NAV.map((item) => {
            const active = item.name === activeRoute;
            const Icon = item.icon;
            return (
              <Pressable
                key={item.name}
                onPress={() => props.navigation.navigate(item.name)}
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 12,
                  paddingVertical: 12,
                  paddingHorizontal: 14,
                  borderRadius: c.radius,
                  backgroundColor: active ? c.accent : "transparent",
                }}
              >
                <Icon
                  size={20}
                  color={active ? c.accentForeground : c.mutedForeground}
                />
                <Text
                  style={{
                    color: active ? c.foreground : c.mutedForeground,
                    fontFamily: active ? "Inter_600SemiBold" : "Inter_500Medium",
                    fontSize: 15,
                  }}
                >
                  {item.label}
                </Text>
              </Pressable>
            );
          })}
        </View>
      </DrawerContentScrollView>

      <View
        style={{
          borderTopWidth: 1,
          borderTopColor: c.border,
          padding: 16,
          paddingBottom: insets.bottom + 16,
          gap: 12,
        }}
      >
        <View style={{ gap: 2 }}>
          <Text
            numberOfLines={1}
            style={{
              color: c.foreground,
              fontFamily: "Inter_600SemiBold",
              fontSize: 14,
            }}
          >
            {user?.fullName || user?.username || "Signed in"}
          </Text>
          <Text
            numberOfLines={1}
            style={{ color: c.mutedForeground, fontSize: 12 }}
          >
            {user?.primaryEmailAddress?.emailAddress ?? ""}
          </Text>
        </View>
        <Pressable
          onPress={async () => {
            await signOut();
            router.replace("/sign-in");
          }}
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: 10,
            paddingVertical: 10,
          }}
        >
          <LogOut size={18} color={c.destructive} />
          <Text
            style={{
              color: c.destructive,
              fontFamily: "Inter_500Medium",
              fontSize: 14,
            }}
          >
            Sign out
          </Text>
        </Pressable>
      </View>
    </View>
  );
}

export default function HomeLayout() {
  const c = useColors();
  const { isLoaded, isSignedIn, getToken } = useAuth();

  // Route every API call's bearer token through Clerk's getToken().
  useEffect(() => {
    setAuthTokenGetter(async () => {
      try {
        return (await getToken()) ?? null;
      } catch {
        return null;
      }
    });
  }, [getToken]);

  if (!isLoaded) {
    return (
      <View
        style={{
          flex: 1,
          backgroundColor: c.background,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <ActivityIndicator color={c.primary} />
      </View>
    );
  }

  if (!isSignedIn) return <Redirect href="/sign-in" />;

  return (
    <Drawer
      drawerContent={(props) => <CustomDrawer {...props} />}
      screenOptions={{
        headerShown: false,
        drawerType: "front",
        swipeEdgeWidth: 60,
        sceneStyle: { backgroundColor: c.background },
      }}
    >
      <Drawer.Screen name="index" />
      <Drawer.Screen name="orax" />
      <Drawer.Screen name="memory" />
      <Drawer.Screen name="library" />
      <Drawer.Screen name="settings" />
      <Drawer.Screen name="help" />
    </Drawer>
  );
}
