import { useAuth, useUser } from "@clerk/expo";
import Constants from "expo-constants";
import { useRouter } from "expo-router";
import {
  Activity,
  CreditCard,
  Info,
  LogOut,
  Mic,
  Moon,
  User as UserIcon,
  Volume2,
} from "lucide-react-native";
import React, { useCallback, useEffect, useState } from "react";
import { ScrollView, Switch, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { ScreenHeader } from "@/components/ScreenHeader";
import { Button, Card, Pill } from "@/components/ui";
import { useColors } from "@/hooks/useColors";
import { getOraUsage, getPreferences, getSubscription, updatePreferences } from "@/lib/api";
import type { BillingSubscription, OraUsage } from "@/lib/types";

const APP_VERSION = Constants.expoConfig?.version ?? "1.0.0";
const APP_BUILD =
  Constants.expoConfig?.ios?.buildNumber ??
  (Constants.expoConfig?.android?.versionCode != null
    ? String(Constants.expoConfig.android.versionCode)
    : null);
const APP_VERSION_LABEL = APP_BUILD
  ? `Version ${APP_VERSION} (${APP_BUILD})`
  : `Version ${APP_VERSION}`;

function formatReset(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "soon";
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

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

function UsageRow({ label, used, limit }: { label: string; used: number; limit: number }) {
  const c = useColors();
  const unlimited = limit <= 0;
  return (
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
      <Text style={{ color: c.foreground, fontSize: 14 }}>{label}</Text>
      <Text style={{ color: c.mutedForeground, fontSize: 13 }}>
        {unlimited ? `${used} used` : `${used} / ${limit}`}
      </Text>
    </View>
  );
}

export default function SettingsScreen() {
  const c = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { signOut } = useAuth();
  const { user } = useUser();

  const [voiceLang, setVoiceLangState] = useState("en");
  const [autoReadReplies, setAutoReadReplies] = useState(false);
  const [subscription, setSubscription] = useState<BillingSubscription | null>(null);
  const [usage, setUsage] = useState<OraUsage | null>(null);

  useEffect(() => {
    getPreferences()
      .then((p) => {
        if (p.voiceLang) setVoiceLangState(p.voiceLang);
        setAutoReadReplies(!!p.autoReadReplies);
      })
      .catch(() => {});
    getSubscription()
      .then(setSubscription)
      .catch(() => {});
    getOraUsage()
      .then(setUsage)
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

  const toggleAutoRead = useCallback(async (value: boolean) => {
    setAutoReadReplies(value);
    try {
      await updatePreferences({ autoReadReplies: value });
    } catch {
      setAutoReadReplies(!value);
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
          description="Ora is designed for a focused dark experience."
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

        <SectionCard
          icon={Volume2}
          title="Read replies aloud"
          description="Ora speaks each new reply automatically in your voice-input language."
        >
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 12,
              backgroundColor: c.muted,
              borderRadius: c.radius,
              paddingHorizontal: 14,
              paddingVertical: 12,
            }}
          >
            <Text style={{ color: c.foreground, fontSize: 14, flex: 1 }}>
              Auto-play spoken replies
            </Text>
            <Switch
              value={autoReadReplies}
              onValueChange={toggleAutoRead}
              trackColor={{ false: c.border, true: c.primary }}
              thumbColor={c.primaryForeground}
            />
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
          icon={Activity}
          title="Usage"
          description="Your Ora activity in the current window."
        >
          {usage ? (
            <View style={{ gap: 8 }}>
              <UsageRow label="Messages" used={usage.messageCount} limit={usage.messageLimit} />
              <UsageRow label="Images" used={usage.imageCount} limit={usage.imageLimit} />
              <Text style={{ color: c.mutedForeground, fontSize: 12 }}>
                {`Resets ${formatReset(usage.resetsAt)} · ${usage.windowHours}h window`}
              </Text>
            </View>
          ) : (
            <Text style={{ color: c.mutedForeground, fontSize: 13 }}>Usage unavailable.</Text>
          )}
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
              {user?.fullName || user?.username || "Ora user"}
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

        <SectionCard icon={Info} title="About" description="App version and build.">
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
            <Text style={{ color: c.foreground, fontSize: 14 }}>Ora</Text>
            <Text style={{ color: c.mutedForeground, fontSize: 13 }}>{APP_VERSION_LABEL}</Text>
          </View>
        </SectionCard>
      </ScrollView>
    </View>
  );
}
