import { useAuth, useUser } from "@clerk/expo";
import { useRouter } from "expo-router";
import { CreditCard, LogOut, Mic, Moon, User as UserIcon } from "lucide-react-native";
import React, { useCallback, useEffect, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { ScreenHeader } from "@/components/ScreenHeader";
import { Button, Card, Pill } from "@/components/ui";
import { useColors } from "@/hooks/useColors";
import { getPreferences, getSubscription, updatePreferences } from "@/lib/api";
import type { BillingSubscription } from "@/lib/types";

const VOICE_LANGS: { code: string; label: string }[] = [
  { code: "en", label: "English" },
  { code: "es", label: "Español" },
  { code: "fr", label: "Français" },
  { code: "de", label: "Deutsch" },
  { code: "pt", label: "Português" },
  { code: "hi", label: "हिन्दी" },
  { code: "zh", label: "中文" },
  { code: "ja", label: "日本語" },
];

function SectionCard({
  icon: Icon,
  title,
  description,
  children,
}: {
  icon: typeof UserIcon;
  title: string;
  description?: string;
  children?: React.ReactNode;
}) {
  const c = useColors();
  return (
    <Card style={{ gap: 12 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
        <Icon size={20} color={c.accentForeground} />
        <View style={{ flex: 1 }}>
          <Text
            style={{
              color: c.foreground,
              fontFamily: "Inter_600SemiBold",
              fontSize: 16,
            }}
          >
            {title}
          </Text>
          {description && (
            <Text style={{ color: c.mutedForeground, fontSize: 13, marginTop: 2 }}>
              {description}
            </Text>
          )}
        </View>
      </View>
      {children}
    </Card>
  );
}

export default function SettingsScreen() {
  const c = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { signOut } = useAuth();
  const { user } = useUser();

  const [voiceLang, setVoiceLangState] = useState("en");
  const [subscription, setSubscription] = useState<BillingSubscription | null>(null);

  useEffect(() => {
    getPreferences()
      .then((p) => p.voiceLang && setVoiceLangState(p.voiceLang))
      .catch(() => {});
    getSubscription()
      .then(setSubscription)
      .catch(() => {});
  }, []);

  const changeVoiceLang = useCallback(async (code: string) => {
    setVoiceLangState(code);
    try {
      await updatePreferences({ voiceLang: code });
    } catch {
      /* ignore */
    }
  }, []);

  return (
    <View style={{ flex: 1, backgroundColor: c.background }}>
      <ScreenHeader title="Settings" subtitle="Preferences & account" />
      <ScrollView
        contentContainerStyle={{
          padding: 16,
          gap: 12,
          paddingBottom: insets.bottom + 24,
        }}
      >
        <SectionCard
          icon={Moon}
          title="Appearance"
          description="MustaFlow is designed for a focused dark experience."
        >
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: 8,
              backgroundColor: c.muted,
              borderRadius: c.radius,
              paddingHorizontal: 14,
              paddingVertical: 12,
            }}
          >
            <Moon size={16} color={c.accentForeground} />
            <Text style={{ color: c.foreground, fontSize: 14 }}>Dark mode (always on)</Text>
          </View>
        </SectionCard>

        <SectionCard
          icon={Mic}
          title="Voice input"
          description="Language used when you dictate messages to Ora."
        >
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
            {VOICE_LANGS.map((l) => (
              <Pill
                key={l.code}
                label={l.label}
                active={voiceLang === l.code}
                onPress={() => changeVoiceLang(l.code)}
              />
            ))}
          </View>
        </SectionCard>

        <SectionCard icon={CreditCard} title="Plan" description="Your current Ora subscription.">
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              justifyContent: "space-between",
              backgroundColor: c.muted,
              borderRadius: c.radius,
              paddingHorizontal: 14,
              paddingVertical: 12,
            }}
          >
            <Text
              style={{
                color: c.foreground,
                fontFamily: "Inter_600SemiBold",
                fontSize: 15,
                textTransform: "capitalize",
              }}
            >
              {subscription?.tier ?? "Free"}
            </Text>
            {subscription?.status && (
              <Text style={{ color: c.mutedForeground, fontSize: 13 }}>{subscription.status}</Text>
            )}
          </View>
        </SectionCard>

        <SectionCard
          icon={UserIcon}
          title="Account"
          description="Your profile and sign-in details."
        >
          <View style={{ gap: 4 }}>
            <Text
              style={{
                color: c.foreground,
                fontFamily: "Inter_500Medium",
                fontSize: 15,
              }}
            >
              {user?.fullName || user?.username || "MustaFlow user"}
            </Text>
            <Text style={{ color: c.mutedForeground, fontSize: 13 }}>
              {user?.primaryEmailAddress?.emailAddress ?? ""}
            </Text>
          </View>
          <Button
            label="Sign out"
            variant="destructive"
            icon={LogOut}
            onPress={async () => {
              await signOut();
              router.replace("/sign-in");
            }}
            full
          />
        </SectionCard>
      </ScrollView>
    </View>
  );
}
