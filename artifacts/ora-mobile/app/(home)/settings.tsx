import { useAuth, useUser } from "@clerk/expo";
import Constants from "expo-constants";
import { useRouter } from "expo-router";
import * as WebBrowser from "expo-web-browser";
import {
  AudioLines,
  Brain,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Circle,
  CreditCard,
  Focus,
  Info,
  Loader,
  LogOut,
  Mic,
  Monitor,
  Moon,
  RefreshCw,
  Shield,
  Sun,
  User as UserIcon,
  Volume2,
  Wifi,
  XCircle,
} from "lucide-react-native";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { Alert, Image, Pressable, ScrollView, Switch, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { LEGAL_SECTIONS } from "@/components/LegalPrivacyModal";
import { ScreenHeader } from "@/components/ScreenHeader";
import { Button, Card, Pill, TextField } from "@/components/ui";
import { type ThemeOverride, useTheme } from "@/context/ThemeContext";
import { useColors } from "@/hooks/useColors";
import { isRealtimeVoiceNativeAvailable } from "@/hooks/useOraRealtimeVoiceNative";
import {
  API_BASE,
  DOMAIN,
  getAccountConsistency,
  getLastStreamDiagnostics,
  getOraUsage,
  getPaymentMethod,
  getPreferences,
  getRealtimeDiagnostics,
  getSubscription,
  updatePreferences,
} from "@/lib/api";
import { TokenUnavailableError } from "@/lib/auth-client";
import { readStoredFocusMode, writeStoredFocusMode } from "@/lib/focus-mode";
import {
  getAutoSaveMemories,
  getReferenceChatHistory,
  getReferenceSavedMemories,
  loadMemorySettings,
  setAutoSaveMemories,
  setReferenceChatHistory,
  setReferenceSavedMemories,
} from "@/lib/memory-settings";
import { getCurrentSessionTier, setCurrentSessionTier } from "@/lib/session-store";
import {
  VOICE_PRESET_LABELS,
  readStoredVoicePreset,
  writeStoredVoicePreset,
} from "@/lib/voice-preset";
import type {
  BillingSubscription,
  OraAccountConsistency,
  OraUsage,
  PaymentMethodInfo,
  RealtimeDiagnostics,
  VoicePreset,
} from "@/lib/types";

const APP_VERSION = Constants.expoConfig?.version ?? "1.0.0";
const APP_BUILD =
  Constants.expoConfig?.ios?.buildNumber ??
  (Constants.expoConfig?.android?.versionCode != null
    ? String(Constants.expoConfig.android.versionCode)
    : null);
const APP_VERSION_LABEL = APP_BUILD
  ? `Version ${APP_VERSION} (${APP_BUILD})`
  : `Version ${APP_VERSION}`;

const STREAMING_ENABLED = process.env.EXPO_PUBLIC_ORA_STREAMING_ENABLED !== "false";
const WEBSITE_SETTINGS_URL = `https://${DOMAIN}/settings`;

const ORA_PRICING_CORE_URL = `https://${DOMAIN}/pricing?tier=core&source=mobile`;
const ORA_PRICING_WAVE_URL = `https://${DOMAIN}/pricing?tier=wave&source=mobile`;
const ORA_PLAN_MANAGE_URL = `https://${DOMAIN}/ora/settings?section=plan&source=mobile`;
const ORA_PAYMENT_METHOD_URL = `https://${DOMAIN}/ora/settings?section=payment-method&source=mobile`;
const ORA_BILLING_URL = `https://${DOMAIN}/ora/settings?section=billing&source=mobile`;

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

const VOICE_LANGS_WITH_AUTO = [{ code: "", label: "Auto-detect" }, ...VOICE_LANGS];

/* ── Helpers ─────────────────────────────────────────────────────────────── */

function fetchWithTimeout(url: string, init: RequestInit, ms: number): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  return fetch(url, { ...init, signal: ctrl.signal }).finally(() => clearTimeout(timer));
}

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

function formatCountdown(iso: string): string {
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return "soon";
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function planLabel(tier?: string | null): string {
  if (tier === "core") return "Core Pack";
  if (tier === "wave") return "Deep Wave";
  return "Free";
}

function formatDuration(seconds: number): string {
  if (!seconds || seconds <= 0) return "—";
  const mins = Math.round(seconds / 60);
  return mins <= 1 ? "1 minute" : `${mins} minutes`;
}

function renewalLabel(subscription: BillingSubscription | null, tier: string): string {
  if (!tier || tier === "free") return "Free plan — no renewal date";
  const raw = subscription?.currentPeriodEnd;
  if (!raw) return "Rolling usage window";
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return "Rolling usage window";
  const formatted = d.toLocaleDateString(undefined, {
    month: "long",
    day: "numeric",
    year: "numeric",
  });
  if (subscription?.cancelAtPeriodEnd) return `Access ends on ${formatted}`;
  return `Renews on ${formatted}`;
}

function clerkError(err: unknown, fallback: string): string {
  if (err && typeof err === "object" && "errors" in err) {
    const errs = (err as { errors?: Array<{ longMessage?: string; message?: string }> }).errors;
    const first = errs?.[0];
    if (first?.longMessage) return first.longMessage;
    if (first?.message) return first.message;
  }
  if (err instanceof Error && err.message) return err.message;
  return fallback;
}

/* ── Diagnostics types ───────────────────────────────────────────────────── */

type DiagStatus = "pending" | "running" | "ok" | "fail";
interface DiagStep {
  id: string;
  label: string;
  url: string;
  status: DiagStatus;
  detail?: string;
  httpStatus?: number;
  errorMsg?: string;
  bodySnippet?: string;
}
type DiagTokenStatus = "unchecked" | "present" | "missing" | "error";
interface DiagPlanSync {
  tokenStatus: DiagTokenStatus;
  sessionTier: string | null;
  sessionIsPaid: boolean | null;
}
const INITIAL_PLAN_SYNC: DiagPlanSync = {
  tokenStatus: "unchecked",
  sessionTier: null,
  sessionIsPaid: null,
};

function initSteps(): DiagStep[] {
  const base = API_BASE;
  const steps: DiagStep[] = [
    {
      id: "transport",
      label: "Transport check",
      url: `${base}/api/public-ai/session`,
      status: "pending",
    },
    {
      id: "session",
      label: "POST /api/public-ai/session",
      url: `${base}/api/public-ai/session`,
      status: "pending",
    },
    {
      id: "chat",
      label: "POST /api/public-ai/chat",
      url: `${base}/api/public-ai/chat`,
      status: "pending",
    },
  ];
  if (STREAMING_ENABLED) {
    steps.push({
      id: "stream",
      label: "POST /api/public-ai/chat/stream",
      url: `${base}/api/public-ai/chat/stream`,
      status: "pending",
    });
  }
  return steps;
}

/* ── UI sub-components ───────────────────────────────────────────────────── */

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
          <Text style={{ color: c.foreground, fontFamily: "Inter_600SemiBold", fontSize: 16 }}>
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

function InfoRow({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  const c = useColors();
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "space-between",
        backgroundColor: c.muted,
        borderRadius: c.radius,
        paddingHorizontal: 14,
        paddingVertical: 10,
      }}
    >
      <Text style={{ color: c.mutedForeground, fontSize: 13 }}>{label}</Text>
      <Text
        numberOfLines={1}
        style={{
          color: warn ? "#f87171" : c.foreground,
          fontSize: 13,
          fontFamily: "Inter_500Medium",
          maxWidth: "60%",
        }}
      >
        {value}
      </Text>
    </View>
  );
}

function ToggleRow({
  label,
  description,
  value,
  onValueChange,
  disabled,
}: {
  label: string;
  description?: string;
  value: boolean;
  onValueChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  const c = useColors();
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "flex-start",
        justifyContent: "space-between",
        gap: 12,
        borderRadius: c.radius,
        borderWidth: 1,
        borderColor: c.border + "99",
        paddingHorizontal: 12,
        paddingVertical: 10,
      }}
    >
      <View style={{ flex: 1, gap: 2 }}>
        <Text
          style={{
            color: disabled ? c.mutedForeground : c.foreground,
            fontFamily: "Inter_500Medium",
            fontSize: 14,
          }}
        >
          {label}
        </Text>
        {description ? (
          <Text style={{ color: c.mutedForeground, fontSize: 12, lineHeight: 17 }}>
            {description}
          </Text>
        ) : null}
      </View>
      <Switch
        value={value}
        onValueChange={onValueChange}
        disabled={disabled}
        trackColor={{ false: c.border, true: disabled ? c.muted : c.primary }}
        thumbColor={c.primaryForeground}
      />
    </View>
  );
}

function BigUsageCard({
  label,
  remaining,
  limit,
}: {
  label: string;
  remaining: number;
  limit: number;
}) {
  const c = useColors();
  const warn = remaining <= 0 || (limit > 0 && remaining < limit * 0.1);
  return (
    <View
      style={{
        flex: 1,
        backgroundColor: c.muted,
        borderRadius: c.radius,
        paddingHorizontal: 14,
        paddingVertical: 12,
        gap: 2,
      }}
    >
      <Text
        style={{
          color: warn ? "#f87171" : c.foreground,
          fontFamily: "Inter_700Bold",
          fontSize: 28,
          lineHeight: 32,
        }}
      >
        {remaining.toLocaleString()}
      </Text>
      <Text style={{ color: c.mutedForeground, fontSize: 12 }}>{label} left</Text>
      <Text style={{ color: c.mutedForeground, fontSize: 12 }}>of {limit.toLocaleString()}</Text>
    </View>
  );
}

function DiagStepRow({ step }: { step: DiagStep }) {
  const c = useColors();
  const isOk = step.status === "ok";
  const isFail = step.status === "fail";
  const isRunning = step.status === "running";
  return (
    <View
      style={{
        borderRadius: c.radius,
        borderWidth: 1,
        borderColor: isFail ? "rgba(239,67,67,0.3)" : isOk ? "rgba(74,222,128,0.2)" : c.border,
        backgroundColor: isFail ? "rgba(239,67,67,0.06)" : isOk ? "rgba(74,222,128,0.05)" : c.muted,
        padding: 12,
        gap: 4,
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        {isOk && <CheckCircle2 size={15} color="#4ade80" />}
        {isFail && <XCircle size={15} color="#f87171" />}
        {isRunning && <Loader size={15} color={c.accentForeground} />}
        {step.status === "pending" && <Circle size={15} color={c.border} />}
        <Text style={{ color: c.foreground, fontSize: 13, fontFamily: "Inter_500Medium", flex: 1 }}>
          {step.label}
        </Text>
        {step.httpStatus != null && (
          <Text
            style={{
              color: isOk ? "#4ade80" : "#f87171",
              fontSize: 12,
              fontFamily: "Inter_500Medium",
            }}
          >
            {step.httpStatus}
          </Text>
        )}
      </View>
      <Text numberOfLines={1} style={{ color: c.mutedForeground, fontSize: 11, marginLeft: 23 }}>
        {step.url}
      </Text>
      {isOk && step.detail ? (
        <Text
          numberOfLines={3}
          style={{ color: "#4ade80", fontSize: 12, marginLeft: 23, marginTop: 2 }}
        >
          {step.detail}
        </Text>
      ) : null}
      {isFail && step.errorMsg ? (
        <Text
          numberOfLines={4}
          style={{ color: "#f87171", fontSize: 12, marginLeft: 23, marginTop: 2 }}
        >
          {step.errorMsg}
        </Text>
      ) : null}
      {isFail && step.bodySnippet ? (
        <Text
          numberOfLines={4}
          style={{
            color: c.mutedForeground,
            fontSize: 11,
            marginLeft: 23,
            marginTop: 2,
            fontFamily: "Inter_400Regular",
          }}
        >
          {step.bodySnippet}
        </Text>
      ) : null}
    </View>
  );
}

/* ── Account section ─────────────────────────────────────────────────────── */

function AccountSection() {
  const { signOut, isSignedIn, isLoaded } = useAuth();
  const { user } = useUser();
  const router = useRouter();
  const c = useColors();

  const [emailMode, setEmailMode] = useState<"idle" | "input" | "verify">("idle");
  const [newEmail, setNewEmail] = useState("");
  const [code, setCode] = useState("");
  const [emailBusy, setEmailBusy] = useState(false);
  const pendingEmailRef = useRef<unknown>(null);

  const [pwOpen, setPwOpen] = useState(false);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [pwBusy, setPwBusy] = useState(false);

  if (!isLoaded || !isSignedIn || !user) {
    return (
      <SectionCard icon={UserIcon} title="Account" description="Your profile and sign-in details.">
        <Button label="Sign in" onPress={() => router.push("/sign-in")} full />
      </SectionCard>
    );
  }

  const emailAddress =
    user.primaryEmailAddress?.emailAddress ?? user.emailAddresses?.[0]?.emailAddress ?? "";
  const emailPrefix = emailAddress.split("@")[0] ?? "";
  const displayName = user.fullName ?? (emailPrefix || "Account");
  const initials = displayName.slice(0, 2).toUpperCase();
  const avatarUrl = user.imageUrl;
  const hasAvatar = !!(avatarUrl && avatarUrl.length > 5);

  function resetEmailFlow() {
    setEmailMode("idle");
    setNewEmail("");
    setCode("");
    pendingEmailRef.current = null;
  }

  function resetPwFlow() {
    setPwOpen(false);
    setCurrentPassword("");
    setNewPassword("");
    setConfirmPassword("");
  }

  async function sendEmailCode() {
    if (!user) return;
    const trimmed = newEmail.trim();
    if (!/.+@.+\..+/.test(trimmed)) {
      Alert.alert("Invalid email", "Please enter a valid email address.");
      return;
    }
    if (typeof user.createEmailAddress !== "function") {
      Alert.alert(
        "Not available",
        "Email changes are not available for this account type. Visit the MustaFlow website to manage your account.",
        [
          {
            text: "Open website",
            onPress: () => void WebBrowser.openBrowserAsync(WEBSITE_SETTINGS_URL),
          },
          { text: "Cancel", style: "cancel" },
        ],
      );
      return;
    }
    setEmailBusy(true);
    try {
      const emailResource = await user.createEmailAddress({ email: trimmed });
      await (
        emailResource as { prepareVerification: (opts: { strategy: string }) => Promise<unknown> }
      ).prepareVerification({ strategy: "email_code" });
      pendingEmailRef.current = emailResource;
      setEmailMode("verify");
    } catch (err) {
      Alert.alert("Could not start email change", clerkError(err, "Please try again."));
    } finally {
      setEmailBusy(false);
    }
  }

  async function confirmEmailCode() {
    if (!user) return;
    const emailResource = pendingEmailRef.current as {
      attemptVerification: (opts: { code: string }) => Promise<unknown>;
      id: string;
    } | null;
    if (!emailResource) return;
    const trimmedCode = code.trim();
    if (!trimmedCode) {
      Alert.alert("Enter the code", "Please enter the verification code we emailed you.");
      return;
    }
    setEmailBusy(true);
    try {
      await emailResource.attemptVerification({ code: trimmedCode });
      await user.update({ primaryEmailAddressId: emailResource.id });
      await user.reload();
      Alert.alert("Email updated", "Your primary email address has been changed.");
      resetEmailFlow();
    } catch (err) {
      Alert.alert(
        "Could not verify email",
        clerkError(err, "The code may be incorrect or expired."),
      );
    } finally {
      setEmailBusy(false);
    }
  }

  async function changePassword() {
    if (!user) return;
    if (newPassword.length < 8) {
      Alert.alert("Password too short", "Your new password must be at least 8 characters.");
      return;
    }
    if (newPassword !== confirmPassword) {
      Alert.alert("Passwords don't match", "The new password and confirmation must match.");
      return;
    }
    if (typeof user.updatePassword !== "function") {
      Alert.alert(
        "Not available",
        "Password changes are not available for this account type. Visit the MustaFlow website to manage your account.",
        [
          {
            text: "Open website",
            onPress: () => void WebBrowser.openBrowserAsync(WEBSITE_SETTINGS_URL),
          },
          { text: "Cancel", style: "cancel" },
        ],
      );
      return;
    }
    setPwBusy(true);
    try {
      await user.updatePassword({ currentPassword, newPassword });
      Alert.alert("Password updated", "Your password has been changed.");
      resetPwFlow();
    } catch (err) {
      Alert.alert(
        "Could not change password",
        clerkError(err, "Check your current password and try again."),
      );
    } finally {
      setPwBusy(false);
    }
  }

  return (
    <SectionCard icon={UserIcon} title="Account" description="Your profile and sign-in details.">
      {/* Avatar + name row */}
      <View style={{ flexDirection: "row", alignItems: "center", gap: 14 }}>
        {hasAvatar ? (
          <Image source={{ uri: avatarUrl }} style={{ width: 48, height: 48, borderRadius: 24 }} />
        ) : (
          <View
            style={{
              width: 48,
              height: 48,
              borderRadius: 24,
              backgroundColor: `${c.primary}30`,
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <Text style={{ color: c.primary, fontFamily: "Inter_700Bold", fontSize: 18 }}>
              {initials}
            </Text>
          </View>
        )}
        <View style={{ flex: 1, gap: 2 }}>
          <Text style={{ color: c.foreground, fontFamily: "Inter_600SemiBold", fontSize: 15 }}>
            {displayName}
          </Text>
          {emailAddress ? (
            <Text style={{ color: c.mutedForeground, fontSize: 13 }}>{emailAddress}</Text>
          ) : null}
        </View>
      </View>

      {/* Email change */}
      {emailMode === "idle" && (
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
            backgroundColor: c.muted,
            borderRadius: c.radius,
            paddingHorizontal: 14,
            paddingVertical: 10,
          }}
        >
          <Text style={{ color: c.mutedForeground, fontSize: 13 }}>Email</Text>
          <Pressable onPress={() => setEmailMode("input")} hitSlop={8}>
            <Text style={{ color: c.primary, fontSize: 13, fontFamily: "Inter_500Medium" }}>
              Change
            </Text>
          </Pressable>
        </View>
      )}
      {emailMode === "input" && (
        <View style={{ gap: 8 }}>
          <TextField
            label="New email address"
            value={newEmail}
            onChangeText={setNewEmail}
            autoCapitalize="none"
            keyboardType="email-address"
          />
          <View style={{ flexDirection: "row", gap: 8 }}>
            <Button label="Cancel" variant="ghost" onPress={resetEmailFlow} style={{ flex: 1 }} />
            <Button
              label={emailBusy ? "Sending…" : "Send code"}
              onPress={() => void sendEmailCode()}
              loading={emailBusy}
              style={{ flex: 1 }}
            />
          </View>
        </View>
      )}
      {emailMode === "verify" && (
        <View style={{ gap: 8 }}>
          <Text style={{ color: c.mutedForeground, fontSize: 13 }}>
            Enter the code we sent to {newEmail.trim()}
          </Text>
          <TextField
            label="Verification code"
            value={code}
            onChangeText={setCode}
            keyboardType="number-pad"
          />
          <View style={{ flexDirection: "row", gap: 8 }}>
            <Button
              label="Back"
              variant="ghost"
              onPress={() => setEmailMode("input")}
              style={{ flex: 1 }}
            />
            <Button
              label={emailBusy ? "Verifying…" : "Verify"}
              onPress={() => void confirmEmailCode()}
              loading={emailBusy}
              style={{ flex: 1 }}
            />
          </View>
        </View>
      )}

      {/* Password change */}
      {!pwOpen && (
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
            backgroundColor: c.muted,
            borderRadius: c.radius,
            paddingHorizontal: 14,
            paddingVertical: 10,
          }}
        >
          <Text style={{ color: c.mutedForeground, fontSize: 13 }}>Password</Text>
          <Pressable onPress={() => setPwOpen(true)} hitSlop={8}>
            <Text style={{ color: c.primary, fontSize: 13, fontFamily: "Inter_500Medium" }}>
              Change
            </Text>
          </Pressable>
        </View>
      )}
      {pwOpen && (
        <View style={{ gap: 8 }}>
          <TextField
            label="Current password"
            value={currentPassword}
            onChangeText={setCurrentPassword}
            secureTextEntry
          />
          <TextField
            label="New password"
            value={newPassword}
            onChangeText={setNewPassword}
            secureTextEntry
          />
          <TextField
            label="Confirm new password"
            value={confirmPassword}
            onChangeText={setConfirmPassword}
            secureTextEntry
          />
          <View style={{ flexDirection: "row", gap: 8 }}>
            <Button label="Cancel" variant="ghost" onPress={resetPwFlow} style={{ flex: 1 }} />
            <Button
              label={pwBusy ? "Saving…" : "Save password"}
              onPress={() => void changePassword()}
              loading={pwBusy}
              style={{ flex: 1 }}
            />
          </View>
        </View>
      )}

      {/* Sign out */}
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
  );
}

/* ── Memory & references section ─────────────────────────────────────────── */

function MemorySection() {
  const [refSaved, setRefSavedLocal] = useState(getReferenceSavedMemories);
  const [refHistory, setRefHistoryLocal] = useState(getReferenceChatHistory);
  const [autoSave, setAutoSaveLocal] = useState(getAutoSaveMemories);

  useEffect(() => {
    void loadMemorySettings().then(() => {
      setRefSavedLocal(getReferenceSavedMemories());
      setRefHistoryLocal(getReferenceChatHistory());
      setAutoSaveLocal(getAutoSaveMemories());
    });
  }, []);

  const handleRefSaved = (v: boolean) => {
    setRefSavedLocal(v);
    setReferenceSavedMemories(v);
    if (!v && autoSave) {
      setAutoSaveLocal(false);
      setAutoSaveMemories(false);
    }
  };

  const handleRefHistory = (v: boolean) => {
    setRefHistoryLocal(v);
    setReferenceChatHistory(v);
  };

  const handleAutoSave = (v: boolean) => {
    setAutoSaveLocal(v);
    setAutoSaveMemories(v);
  };

  return (
    <SectionCard
      icon={Brain}
      title="Memory & references"
      description="Control what Ora remembers and references when replying to you."
    >
      <View style={{ gap: 8 }}>
        <ToggleRow
          label="Reference saved memories"
          description="Let Ora use your saved memories when replying."
          value={refSaved}
          onValueChange={handleRefSaved}
        />
        <ToggleRow
          label="Reference chat history"
          description="Let Ora consider earlier messages in the current conversation for more relevant replies."
          value={refHistory}
          onValueChange={handleRefHistory}
        />
        <ToggleRow
          label="Auto-save memories"
          description="Automatically save facts when you explicitly ask Ora to remember them."
          value={autoSave}
          onValueChange={handleAutoSave}
          disabled={!refSaved}
        />
      </View>
    </SectionCard>
  );
}

/* ── Main screen ─────────────────────────────────────────────────────────── */

export default function SettingsScreen() {
  const c = useColors();
  const insets = useSafeAreaInsets();
  const { getToken, isSignedIn } = useAuth();
  const { themeOverride, setThemeOverride } = useTheme();

  const [voiceLang, setVoiceLangState] = useState("");
  const [autoReadReplies, setAutoReadReplies] = useState(false);
  const [focusFocused, setFocusFocused] = useState(true);
  const [voicePreset, setVoicePresetState] = useState<VoicePreset>("marine");
  const [subscription, setSubscription] = useState<BillingSubscription | null>(null);
  const [subscriptionError, setSubscriptionError] = useState<string | null>(null);
  const [usage, setUsage] = useState<OraUsage | null>(null);
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethodInfo | null>(null);
  const [realtimeDiag, setRealtimeDiag] = useState<RealtimeDiagnostics | null>(null);
  const realtimeDeviceReady = isRealtimeVoiceNativeAvailable();

  useEffect(() => {
    readStoredFocusMode()
      .then((mode) => setFocusFocused(mode === "focused"))
      .catch(() => {});
    readStoredVoicePreset()
      .then(setVoicePresetState)
      .catch(() => {});
    getPreferences()
      .then((p) => {
        setVoiceLangState(p.voiceLang ?? "");
        setAutoReadReplies(!!p.autoReadReplies);
      })
      .catch(() => {});
    getRealtimeDiagnostics()
      .then(setRealtimeDiag)
      .catch(() => {});
    if (isSignedIn) {
      setSubscriptionError(null);
      getSubscription()
        .then(setSubscription)
        .catch((err) => {
          const msg =
            err instanceof TokenUnavailableError
              ? "Re-sync sign-in to load plan details."
              : err instanceof Error
                ? err.message
                : "Unable to load plan details.";
          setSubscriptionError(msg);
        });
      getOraUsage()
        .then(setUsage)
        .catch(() => {});
      getPaymentMethod()
        .then(setPaymentMethod)
        .catch(() => {});
    }
  }, [isSignedIn]);

  const changeVoiceLang = useCallback(async (code: string) => {
    setVoiceLangState(code);
    try {
      await updatePreferences({ voiceLang: code || undefined });
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

  const toggleFocusMode = useCallback((value: boolean) => {
    setFocusFocused(value);
    void writeStoredFocusMode(value ? "focused" : "normal");
  }, []);

  const changeVoicePreset = useCallback((preset: VoicePreset) => {
    setVoicePresetState(preset);
    void writeStoredVoicePreset(preset);
  }, []);

  /* ── About sub-view ─────────────────────────────────────────────────────── */

  const [aboutView, setAboutView] = useState<null | "diagnostics" | "account-sync" | "legal">(
    null,
  );

  /* ── Diagnostics ───────────────────────────────────────────────────────── */

  const [diagSteps, setDiagSteps] = useState<DiagStep[]>([]);
  const [diagLoading, setDiagLoading] = useState(false);
  const [diagPlanSync, setDiagPlanSync] = useState<DiagPlanSync>(INITIAL_PLAN_SYNC);
  const diagRunningRef = useRef(false);

  /* ── Account sync ────────────────────────────────────────────────────────── */

  const [acctDiag, setAcctDiag] = useState<OraAccountConsistency | null>(null);
  const [acctLoading, setAcctLoading] = useState(false);
  const [acctError, setAcctError] = useState<string | null>(null);
  const [acctTokenMissing, setAcctTokenMissing] = useState(false);
  const [acctLocalSignedIn, setAcctLocalSignedIn] = useState<boolean | null>(null);
  const [acctTokenPresent, setAcctTokenPresent] = useState<boolean | null>(null);
  const [acctPublicSessionTier, setAcctPublicSessionTier] = useState<string | null>(null);
  const [acctPublicSessionIsPaid, setAcctPublicSessionIsPaid] = useState<boolean | null>(null);
  const [acctLocalSessionTier, setAcctLocalSessionTier] = useState<string | null>(null);
  const acctRunningRef = useRef(false);

  const runAccountCheck = useCallback(async () => {
    if (acctRunningRef.current) return;
    acctRunningRef.current = true;
    setAcctLoading(true);
    setAcctError(null);
    setAcctTokenMissing(false);
    setAcctLocalSignedIn(!!isSignedIn);
    setAcctTokenPresent(null);
    setAcctPublicSessionTier(null);
    setAcctPublicSessionIsPaid(null);
    setAcctLocalSessionTier(getCurrentSessionTier());
    try {
      if (isSignedIn) {
        let token: string | null = null;
        try {
          token = await getToken();
        } catch {
          token = null;
        }
        setAcctTokenPresent(!!token);
        if (!token) setAcctTokenMissing(true);
      }
      const data = await getAccountConsistency();
      setAcctDiag(data);
      setAcctPublicSessionTier(data.chatSession.tier);
      setAcctPublicSessionIsPaid(data.chatSession.isPaid);
      setCurrentSessionTier(data.chatSession.tier, data.chatSession.isPaid);
    } catch (err) {
      setAcctDiag(null);
      if (err instanceof TokenUnavailableError) {
        setAcctTokenMissing(true);
        setAcctTokenPresent(false);
      } else {
        const msg = err instanceof Error ? err.message : String(err);
        setAcctError(msg);
      }
    } finally {
      setAcctLoading(false);
      acctRunningRef.current = false;
    }
  }, [getToken, isSignedIn]);

  const updateStep = useCallback((id: string, patch: Partial<DiagStep>) => {
    setDiagSteps((prev) => prev.map((s) => (s.id === id ? { ...s, ...patch } : s)));
  }, []);

  const runDiagnostics = useCallback(async () => {
    if (diagRunningRef.current) return;
    diagRunningRef.current = true;
    setDiagLoading(true);
    const steps = initSteps();
    setDiagSteps(steps);
    setDiagPlanSync(INITIAL_PLAN_SYNC);

    let authHeaders: HeadersInit = {};
    try {
      const token = await getToken();
      if (token) {
        authHeaders = { Authorization: `Bearer ${token}` };
        setDiagPlanSync((prev) => ({ ...prev, tokenStatus: "present" }));
      } else {
        setDiagPlanSync((prev) => ({ ...prev, tokenStatus: "missing" }));
      }
    } catch {
      setDiagPlanSync((prev) => ({ ...prev, tokenStatus: "error" }));
    }

    const jsonHeaders: HeadersInit = { "Content-Type": "application/json", ...authHeaders };

    updateStep("transport", { status: "running" });
    try {
      const r = await fetchWithTimeout(
        `${API_BASE}/api/public-ai/session`,
        { method: "GET", headers: authHeaders },
        8000,
      );
      if (r.status < 500) {
        updateStep("transport", { status: "ok", httpStatus: r.status, detail: "Server reachable" });
      } else {
        let body = "";
        try {
          body = (await r.text()).slice(0, 200);
        } catch {
          /* ignore */
        }
        updateStep("transport", { status: "fail", httpStatus: r.status, bodySnippet: body });
      }
    } catch (err) {
      updateStep("transport", {
        status: "fail",
        errorMsg: `${err instanceof Error ? err.name : "Error"}: ${err instanceof Error ? err.message : String(err)}`,
      });
    }

    updateStep("session", { status: "running" });
    try {
      const r = await fetchWithTimeout(
        `${API_BASE}/api/public-ai/session`,
        { method: "POST", headers: jsonHeaders },
        12000,
      );
      let body = "";
      try {
        body = (await r.text()).slice(0, 400);
      } catch {
        /* ignore */
      }
      if (r.ok) {
        let parsed: Record<string, unknown> | null = null;
        try {
          parsed = JSON.parse(body) as Record<string, unknown>;
        } catch {
          /* ignore */
        }
        const detail = parsed
          ? `msgs ${String(parsed.msgCount ?? "?")}/${String(parsed.msgLimit ?? "?")}, tier: ${String(parsed.tier ?? "free/anonymous")}`
          : "OK";
        const sessionTier = typeof parsed?.tier === "string" ? parsed.tier : null;
        const sessionIsPaid = parsed?.isPaid === true;
        setDiagPlanSync((prev) => ({ ...prev, sessionTier, sessionIsPaid }));
        updateStep("session", { status: "ok", httpStatus: r.status, detail });
      } else {
        updateStep("session", { status: "fail", httpStatus: r.status, bodySnippet: body });
      }
    } catch (err) {
      updateStep("session", {
        status: "fail",
        errorMsg: `${err instanceof Error ? err.name : "Error"}: ${err instanceof Error ? err.message : String(err)}`,
      });
    }

    updateStep("chat", { status: "running" });
    try {
      const chatBody = JSON.stringify({
        message: "hi",
        messages: [],
        language: "en",
        mode: "instant",
        referenceSavedMemories: false,
        referenceChatHistory: false,
        temporary: true,
      });
      const r = await fetchWithTimeout(
        `${API_BASE}/api/public-ai/chat`,
        { method: "POST", headers: jsonHeaders, body: chatBody },
        25000,
      );
      let body = "";
      try {
        body = (await r.text()).slice(0, 500);
      } catch {
        /* ignore */
      }
      if (r.ok) {
        let parsed: Record<string, unknown> | null = null;
        try {
          parsed = JSON.parse(body) as Record<string, unknown>;
        } catch {
          /* ignore */
        }
        const reply =
          typeof parsed?.reply === "string" ? parsed.reply.trim().slice(0, 100) : body.slice(0, 80);
        updateStep("chat", {
          status: "ok",
          httpStatus: r.status,
          detail: reply || "(empty reply)",
        });
      } else {
        updateStep("chat", { status: "fail", httpStatus: r.status, bodySnippet: body });
      }
    } catch (err) {
      updateStep("chat", {
        status: "fail",
        errorMsg: `${err instanceof Error ? err.name : "Error"}: ${err instanceof Error ? err.message : String(err)}`,
      });
    }

    if (STREAMING_ENABLED) {
      updateStep("stream", { status: "running" });
      const streamCtrl = new AbortController();
      const streamTimer = setTimeout(() => streamCtrl.abort(), 10000);
      try {
        const streamBody = JSON.stringify({
          message: "hi",
          messages: [],
          language: "en",
          mode: "instant",
          referenceSavedMemories: false,
          referenceChatHistory: false,
          temporary: true,
        });
        const r = await fetch(`${API_BASE}/api/public-ai/chat/stream`, {
          method: "POST",
          headers: jsonHeaders,
          body: streamBody,
          signal: streamCtrl.signal,
        });
        clearTimeout(streamTimer);
        streamCtrl.abort();
        const ct = r.headers.get("content-type") ?? "(none)";
        if (r.ok) {
          updateStep("stream", { status: "ok", httpStatus: r.status, detail: ct });
        } else {
          let body = "";
          try {
            body = (await r.text()).slice(0, 200);
          } catch {
            /* ignore */
          }
          updateStep("stream", { status: "fail", httpStatus: r.status, bodySnippet: body });
        }
      } catch (err) {
        clearTimeout(streamTimer);
        const isAbort = err instanceof Error && err.name === "AbortError";
        if (isAbort) {
          updateStep("stream", {
            status: "fail",
            errorMsg: "Timed out — no response headers within 10 s",
          });
        } else {
          updateStep("stream", {
            status: "fail",
            errorMsg: `${err instanceof Error ? err.name : "Error"}: ${err instanceof Error ? err.message : String(err)}`,
          });
        }
      }
    }

    setDiagLoading(false);
    diagRunningRef.current = false;
  }, [getToken, updateStep]);

  /* ── Derived values ─────────────────────────────────────────────────────── */

  const THEME_OPTIONS: { value: ThemeOverride; label: string; Icon: typeof Sun }[] = [
    { value: "system", label: "System", Icon: Monitor },
    { value: "light", label: "Light", Icon: Sun },
    { value: "dark", label: "Dark", Icon: Moon },
  ];

  const allOk = diagSteps.length > 0 && diagSteps.every((s) => s.status === "ok");
  const anyFail = diagSteps.some((s) => s.status === "fail");
  const currentTier = subscription?.tier ?? "free";
  const isPaid = currentTier === "core" || currentTier === "wave";
  const signedInEmail =
    typeof isSignedIn === "boolean" && isSignedIn
      ? diagPlanSync.tokenStatus !== "unchecked"
        ? (acctDiag?.identity.email ?? "—")
        : "—"
      : "anonymous";
  const sessionTierForCompare = diagPlanSync.sessionTier ?? "free";
  const billingTier = subscription?.tier ?? null;
  const billingTierIsPaid = billingTier === "core" || billingTier === "wave";
  const signedInMissingToken =
    !!isSignedIn &&
    (diagPlanSync.tokenStatus === "missing" || diagPlanSync.tokenStatus === "error");
  const planTierMismatch =
    !!isSignedIn &&
    diagPlanSync.tokenStatus !== "unchecked" &&
    !!billingTier &&
    sessionTierForCompare !== billingTier;
  const planSyncWarn = signedInMissingToken || (billingTierIsPaid && planTierMismatch);
  const planSyncMessage = signedInMissingToken
    ? "Signed in locally, but diagnostics could not get a Clerk token. Ora chat will resolve as anonymous/free until auth is fixed."
    : billingTierIsPaid && planTierMismatch
      ? `Plan mismatch: billing says ${planLabel(billingTier)} but chat session says ${planLabel(sessionTierForCompare)}. The chat request is not resolving the same paid user.`
      : null;
  const tokenStatusLabel =
    diagPlanSync.tokenStatus === "unchecked"
      ? "not checked"
      : diagPlanSync.tokenStatus === "present"
        ? "present"
        : diagPlanSync.tokenStatus === "missing"
          ? "missing"
          : "error";
  const billingTierLabel = !isSignedIn
    ? "anonymous"
    : billingTier
      ? `${planLabel(billingTier)} (${subscription?.status ?? "unknown"})`
      : "unknown";
  const chatTierLabel =
    diagPlanSync.tokenStatus === "unchecked"
      ? "not checked"
      : `${planLabel(sessionTierForCompare)}${diagPlanSync.sessionIsPaid ? " (paid)" : ""}`;

  const acctActivePaidStatus =
    acctDiag?.billing.status === "active" || acctDiag?.billing.status === "trialing";
  const acctBillingPaid =
    (acctDiag?.billing.sourceTier === "core" || acctDiag?.billing.sourceTier === "wave") &&
    acctActivePaidStatus;
  const acctChatFree = acctDiag ? !acctDiag.chatSession.isPaid : false;
  const acctTierMismatch = !!acctDiag && acctBillingPaid && acctChatFree;
  const acctTokenWarn = !!isSignedIn && (acctTokenMissing || (!!acctError && !acctDiag));
  const acctLocalSessionMismatch =
    !!isSignedIn &&
    acctBillingPaid &&
    acctLocalSessionTier !== null &&
    acctLocalSessionTier !== (acctDiag?.billing.billingTier ?? null);
  const acctSessionAuthenticated: string | null =
    acctPublicSessionTier !== null
      ? acctPublicSessionIsPaid
        ? "yes (paid)"
        : "no (free/anonymous)"
      : null;
  const acctWarnMessage = acctTokenWarn
    ? "Signed in on this device, but no Clerk token reached the server. Ora will resolve as anonymous/free here until sign-in is fixed."
    : acctLocalSessionMismatch
      ? `Session mismatch: the Ora session created at startup was ${planLabel(acctLocalSessionTier ?? null)} but the server reports ${planLabel(acctDiag?.billing.billingTier ?? null)}. The session may have been created before sign-in was ready — tap Check Account to re-sync.`
      : acctTierMismatch
        ? `Plan mismatch: billing says ${planLabel(acctDiag?.billing.sourceTier ?? null)} but this device's chat session is ${planLabel(acctDiag?.chatSession.tier ?? null)}. This device is not resolving the same paid account.`
        : null;

  const msgRemaining = usage ? Math.max(0, usage.messageLimit - usage.messageCount) : null;
  const imgRemaining = usage ? Math.max(0, usage.imageLimit - usage.imageCount) : null;
  const windowStarted = usage ? usage.messageCount > 0 || usage.imageCount > 0 : false;

  const pmBrand = paymentMethod?.brand
    ? paymentMethod.brand.slice(0, 1).toUpperCase() + paymentMethod.brand.slice(1)
    : "Card";
  const pmExpiry =
    paymentMethod?.expMonth && paymentMethod?.expYear
      ? `${paymentMethod.expMonth}/${String(paymentMethod.expYear).slice(-2)}`
      : null;
  const pmExpired = paymentMethod?.status === "expired";

  return (
    <View style={{ flex: 1, backgroundColor: c.background }}>
      <ScreenHeader title="Settings" subtitle="Preferences & account" />
      <ScrollView
        contentContainerStyle={{ padding: 16, gap: 12, paddingBottom: insets.bottom + 24 }}
      >
        {/* 1. Account */}
        <AccountSection />

        {/* 2. Appearance */}
        <SectionCard
          icon={Sun}
          title="Appearance"
          description="Choose light, dark, or follow your system setting."
        >
          <View style={{ flexDirection: "row", gap: 8 }}>
            {THEME_OPTIONS.map(({ value, label, Icon }) => {
              const active = themeOverride === value;
              return (
                <Pressable
                  key={value}
                  onPress={() => void setThemeOverride(value)}
                  accessibilityRole="radio"
                  accessibilityState={{ selected: active }}
                  style={{
                    flex: 1,
                    flexDirection: "row",
                    alignItems: "center",
                    justifyContent: "center",
                    gap: 6,
                    paddingVertical: 10,
                    borderRadius: c.radius,
                    borderWidth: 1,
                    borderColor: active ? c.primary : c.border,
                    backgroundColor: active ? `${c.primary}18` : c.muted,
                  }}
                >
                  <Icon size={14} color={active ? c.primary : c.mutedForeground} />
                  <Text
                    style={{
                      color: active ? c.primary : c.mutedForeground,
                      fontSize: 13,
                      fontFamily: active ? "Inter_600SemiBold" : "Inter_500Medium",
                    }}
                  >
                    {label}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </SectionCard>

        {/* 3. Voice input (with Auto-detect) */}
        <SectionCard
          icon={Mic}
          title="Voice input"
          description="Language used when you dictate messages to Ora."
        >
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
            {VOICE_LANGS_WITH_AUTO.map((l) => (
              <Pill
                key={l.code || "__auto__"}
                label={l.label}
                active={voiceLang === l.code}
                onPress={() => void changeVoiceLang(l.code)}
              />
            ))}
          </View>
          {voiceLang === "" && (
            <Text style={{ color: c.mutedForeground, fontSize: 12, lineHeight: 17, marginTop: 2 }}>
              Ora will detect and match the language you speak or type.
            </Text>
          )}
        </SectionCard>

        {/* 4. Read replies aloud (mobile-only) */}
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
              onValueChange={(v) => void toggleAutoRead(v)}
              trackColor={{ false: c.border, true: c.primary }}
              thumbColor={c.primaryForeground}
            />
          </View>
        </SectionCard>

        {/* 5. Live voice (Talk to Ora) */}
        <SectionCard
          icon={AudioLines}
          title="Live voice (Talk to Ora)"
          description="Talk to Ora in a natural, real-time spoken conversation. If live voice is unavailable, Talk mode falls back to basic voice with a notice."
        >
          {realtimeDiag ? (
            <View style={{ gap: 2 }}>
              <InfoRow
                label="Service"
                value={
                  realtimeDiag.killSwitch
                    ? "Temporarily off"
                    : !realtimeDiag.configured
                      ? "Not configured"
                      : realtimeDiag.enabled
                        ? "Available"
                        : "Unavailable"
                }
                warn={!realtimeDiag.enabled}
              />
              <View
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 12,
                  paddingVertical: 8,
                }}
              >
                <Text style={{ color: c.mutedForeground, fontSize: 13 }}>Voice</Text>
                <View style={{ flexDirection: "row", gap: 8 }}>
                  {(realtimeDiag.voices?.length
                    ? realtimeDiag.voices
                    : [
                        { key: "marine" as VoicePreset, label: VOICE_PRESET_LABELS.marine },
                        { key: "mustafa" as VoicePreset, label: VOICE_PRESET_LABELS.mustafa },
                      ]
                  ).map((v) => {
                    const active = voicePreset === v.key;
                    return (
                      <Pressable
                        key={v.key}
                        onPress={() => changeVoicePreset(v.key)}
                        accessibilityRole="radio"
                        accessibilityState={{ selected: active }}
                        style={{
                          paddingVertical: 6,
                          paddingHorizontal: 14,
                          borderRadius: c.radius,
                          borderWidth: 1,
                          borderColor: active ? c.primary : c.border,
                          backgroundColor: active ? `${c.primary}18` : c.muted,
                        }}
                      >
                        <Text
                          style={{
                            color: active ? c.primary : c.mutedForeground,
                            fontSize: 13,
                            fontFamily: active ? "Inter_600SemiBold" : "Inter_500Medium",
                          }}
                        >
                          {v.label}
                        </Text>
                      </Pressable>
                    );
                  })}
                </View>
              </View>
              <InfoRow
                label="Max session"
                value={formatDuration(realtimeDiag.maxDurationSeconds)}
              />
              {typeof realtimeDiag.remainingSeconds === "number" &&
                typeof realtimeDiag.limitSeconds === "number" && (
                  <InfoRow
                    label="Voice time left"
                    value={`${formatDuration(Math.max(0, realtimeDiag.remainingSeconds))} of ${formatDuration(realtimeDiag.limitSeconds)}`}
                  />
                )}
              {realtimeDiag.resetsAt && (
                <InfoRow label="Refreshes" value={formatReset(realtimeDiag.resetsAt)} />
              )}
              <InfoRow label="Plan" value={planLabel(realtimeDiag.tier)} />
              <InfoRow
                label="This device"
                value={realtimeDeviceReady ? "Ready" : "Update app to enable"}
                warn={!realtimeDeviceReady}
              />
            </View>
          ) : (
            <Text style={{ color: c.mutedForeground, fontSize: 13 }}>
              Checking live voice availability...
            </Text>
          )}
        </SectionCard>

        {/* 6. Speaker focus */}
        <SectionCard
          icon={Focus}
          title="Speaker focus"
          description="Controls how Talk to Ora handles other voices in the room. Saved on this device only."
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
            <View style={{ flex: 1, gap: 2 }}>
              <Text style={{ color: c.foreground, fontSize: 14 }}>Focused listening</Text>
              <Text style={{ color: c.mutedForeground, fontSize: 12 }}>
                {focusFocused
                  ? "Ora replies to you and stays quiet for nearby background speakers."
                  : "Ora replies to any nearby speech (original behavior)."}
              </Text>
            </View>
            <Switch
              value={focusFocused}
              onValueChange={toggleFocusMode}
              trackColor={{ false: c.border, true: c.primary }}
              thumbColor={c.primaryForeground}
            />
          </View>
        </SectionCard>

        {/* 7. Memory & references */}
        <MemorySection />

        {/* 8. Plan & billing (signed-in only) */}
        {isSignedIn && (
          <SectionCard
            icon={CreditCard}
            title="Plan & billing"
            description="Your Ora plan, usage, and billing."
          >
            <View style={{ gap: 10 }}>
              {subscriptionError ? (
                <View
                  style={{
                    backgroundColor: "rgba(239,67,67,0.08)",
                    borderRadius: c.radius,
                    borderWidth: 1,
                    borderColor: "rgba(239,67,67,0.3)",
                    paddingHorizontal: 14,
                    paddingVertical: 12,
                    gap: 10,
                  }}
                >
                  <Text style={{ color: "#f87171", fontSize: 13, lineHeight: 18 }}>
                    {subscriptionError}
                  </Text>
                  <Button
                    label="Retry"
                    onPress={() => {
                      setSubscriptionError(null);
                      getSubscription()
                        .then(setSubscription)
                        .catch((err) => {
                          const msg =
                            err instanceof TokenUnavailableError
                              ? "Re-sync sign-in to load plan details."
                              : err instanceof Error
                                ? err.message
                                : "Unable to load plan details.";
                          setSubscriptionError(msg);
                        });
                    }}
                    full
                  />
                </View>
              ) : (
                <>
                  {/* Current plan card */}
                  <View
                    style={{
                      backgroundColor: c.muted,
                      borderRadius: c.radius,
                      paddingHorizontal: 14,
                      paddingVertical: 12,
                      gap: 4,
                    }}
                  >
                    <View
                      style={{
                        flexDirection: "row",
                        alignItems: "center",
                        justifyContent: "space-between",
                        gap: 10,
                      }}
                    >
                      <Text
                        style={{ color: c.foreground, fontFamily: "Inter_700Bold", fontSize: 17 }}
                      >
                        {planLabel(currentTier)}
                      </Text>
                      {subscription?.status && subscription.status !== "active" && (
                        <Text style={{ color: c.mutedForeground, fontSize: 13 }}>
                          {subscription.status}
                        </Text>
                      )}
                    </View>
                    <Text style={{ color: c.mutedForeground, fontSize: 13 }}>
                      {renewalLabel(subscription, currentTier)}
                    </Text>
                  </View>

                  {/* Usage grid */}
                  {usage && msgRemaining !== null && imgRemaining !== null && (
                    <>
                      <View style={{ flexDirection: "row", gap: 8 }}>
                        <BigUsageCard
                          label="Messages"
                          remaining={msgRemaining}
                          limit={usage.messageLimit}
                        />
                        <BigUsageCard
                          label="Images"
                          remaining={imgRemaining}
                          limit={usage.imageLimit}
                        />
                      </View>
                      <Text style={{ color: c.mutedForeground, fontSize: 12, textAlign: "center" }}>
                        {windowStarted
                          ? `Messages and images refill together in ${formatCountdown(usage.resetsAt)}`
                          : "Full allowance available — your window starts on your next message"}
                      </Text>
                    </>
                  )}

                  {/* Upgrade buttons */}
                  {!isPaid && (
                    <Button
                      label="Upgrade to Core Pack"
                      onPress={() => void WebBrowser.openBrowserAsync(ORA_PRICING_CORE_URL)}
                      full
                    />
                  )}
                  {currentTier !== "wave" && (
                    <Button
                      label="Upgrade to Deep Wave"
                      variant="secondary"
                      onPress={() => void WebBrowser.openBrowserAsync(ORA_PRICING_WAVE_URL)}
                      full
                    />
                  )}
                  {isPaid && (
                    <Button
                      label="Manage Ora plan"
                      variant="secondary"
                      onPress={() => void WebBrowser.openBrowserAsync(ORA_PLAN_MANAGE_URL)}
                      full
                    />
                  )}

                  {/* Payment method */}
                  {paymentMethod && (
                    <View
                      style={{
                        backgroundColor: c.muted,
                        borderRadius: c.radius,
                        paddingHorizontal: 14,
                        paddingVertical: 12,
                        gap: 8,
                      }}
                    >
                      {paymentMethod.hasPaymentMethod ? (
                        <>
                          <View style={{ gap: 3 }}>
                            <View
                              style={{
                                flexDirection: "row",
                                alignItems: "center",
                                justifyContent: "space-between",
                              }}
                            >
                              <Text
                                style={{
                                  color: c.foreground,
                                  fontFamily: "Inter_500Medium",
                                  fontSize: 14,
                                }}
                              >
                                {pmBrand} ending {paymentMethod.last4}
                              </Text>
                              {pmExpired && (
                                <View
                                  style={{
                                    backgroundColor: "rgba(239,67,67,0.15)",
                                    borderRadius: 4,
                                    paddingHorizontal: 6,
                                    paddingVertical: 2,
                                  }}
                                >
                                  <Text
                                    style={{
                                      color: "#f87171",
                                      fontSize: 11,
                                      fontFamily: "Inter_500Medium",
                                    }}
                                  >
                                    Expired
                                  </Text>
                                </View>
                              )}
                            </View>
                            {pmExpiry && (
                              <Text style={{ color: c.mutedForeground, fontSize: 12 }}>
                                Expires {pmExpiry}
                              </Text>
                            )}
                          </View>
                          <View style={{ gap: 6 }}>
                            <Button
                              label="Change payment method"
                              variant="secondary"
                              onPress={() => void WebBrowser.openBrowserAsync(ORA_PAYMENT_METHOD_URL)}
                              full
                            />
                            <Button
                              label="Manage billing"
                              variant="ghost"
                              onPress={() => void WebBrowser.openBrowserAsync(ORA_BILLING_URL)}
                              full
                            />
                          </View>
                        </>
                      ) : (
                        <>
                          <Text style={{ color: c.mutedForeground, fontSize: 13 }}>
                            No payment method on file.
                          </Text>
                          <Button
                            label="Add payment method"
                            onPress={() => void WebBrowser.openBrowserAsync(ORA_PAYMENT_METHOD_URL)}
                            full
                          />
                        </>
                      )}
                    </View>
                  )}
                </>
              )}
            </View>
          </SectionCard>
        )}

        {/* 9. About */}
        <SectionCard icon={Info} title="About" description="App version, diagnostics, and legal.">
          {/* Version row — always visible */}
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

          {aboutView === null ? (
            /* ── Sub-section menu ──────────────────────────────────────────── */
            <View style={{ gap: 1 }}>
              {(
                [
                  { id: "diagnostics", label: "Diagnostics", Icon: Wifi },
                  { id: "account-sync", label: "Account sync", Icon: RefreshCw },
                  { id: "legal", label: "Legal & Privacy", Icon: Shield },
                ] as const
              ).map(({ id, label, Icon }) => (
                <Pressable
                  key={id}
                  onPress={() => setAboutView(id)}
                  style={({ pressed }) => ({
                    flexDirection: "row",
                    alignItems: "center",
                    justifyContent: "space-between",
                    backgroundColor: pressed ? c.muted : "transparent",
                    borderRadius: c.radius,
                    paddingHorizontal: 14,
                    paddingVertical: 13,
                  })}
                >
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
                    <Icon size={16} color={c.mutedForeground} />
                    <Text style={{ color: c.foreground, fontSize: 14 }}>{label}</Text>
                  </View>
                  <ChevronRight size={16} color={c.mutedForeground} />
                </Pressable>
              ))}
            </View>
          ) : (
            /* ── Back row ──────────────────────────────────────────────────── */
            <Pressable
              onPress={() => setAboutView(null)}
              style={({ pressed }) => ({
                flexDirection: "row",
                alignItems: "center",
                gap: 6,
                paddingVertical: 4,
                opacity: pressed ? 0.6 : 1,
              })}
            >
              <ChevronLeft size={16} color={c.primary} />
              <Text style={{ color: c.primary, fontSize: 14, fontFamily: "Inter_500Medium" }}>
                Back
              </Text>
            </Pressable>
          )}

          {/* ── Diagnostics sub-view ─────────────────────────────────────── */}
          {aboutView === "diagnostics" && (
            <View style={{ gap: 12 }}>
              <View style={{ gap: 6 }}>
                <InfoRow label="API URL" value={API_BASE} />
                <InfoRow label="Streaming" value={STREAMING_ENABLED ? "on" : "off"} />
                <InfoRow label="Signed in" value={isSignedIn ? "yes" : "no"} warn={!isSignedIn} />
                <InfoRow label="Email" value={isSignedIn ? signedInEmail : "anonymous"} />
                <InfoRow label="Clerk token" value={tokenStatusLabel} warn={signedInMissingToken} />
                <InfoRow
                  label="Billing tier"
                  value={billingTierLabel}
                  warn={!!isSignedIn && !billingTier}
                />
                <InfoRow label="Chat tier" value={chatTierLabel} warn={planSyncWarn} />
                <InfoRow
                  label="Clerk key"
                  value={process.env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY ? "set" : "MISSING"}
                  warn={!process.env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY}
                />
                <InfoRow label="Slug" value={Constants.expoConfig?.slug ?? "—"} />
                <InfoRow label="Build" value={APP_VERSION_LABEL} />
                {(() => {
                  const sd = getLastStreamDiagnostics();
                  if (!sd) return null;
                  return (
                    <View style={{ marginTop: 6, gap: 4 }}>
                      <Text
                        style={{
                          color: c.mutedForeground,
                          fontSize: 11,
                          fontFamily: "Inter_600SemiBold",
                          letterSpacing: 0.5,
                          textTransform: "uppercase",
                          marginBottom: 2,
                        }}
                      >
                        Streaming runtime (last chat)
                      </Text>
                      <InfoRow
                        label="ReadableStream"
                        value={sd.readableStreamAvailable ? "available" : "unavailable"}
                      />
                      <InfoRow
                        label="Kill switch"
                        value={sd.killSwitchActive ? "ON" : "off"}
                        warn={sd.killSwitchActive}
                      />
                      <InfoRow
                        label="Auth"
                        value={sd.authResult + (sd.authMs != null ? ` (${sd.authMs}ms)` : "")}
                        warn={sd.authResult === "threw"}
                      />
                      <InfoRow
                        label="XHR used"
                        value={sd.xhrUsed ? "yes" : "no"}
                        warn={!sd.xhrUsed && !sd.killSwitchActive}
                      />
                      {sd.endpointUrl ? (
                        <InfoRow
                          label="Endpoint"
                          value={sd.endpointUrl.replace(`https://${DOMAIN}`, "")}
                        />
                      ) : null}
                      {sd.httpStatus != null ? (
                        <InfoRow
                          label="HTTP status"
                          value={String(sd.httpStatus)}
                          warn={sd.httpStatus >= 400}
                        />
                      ) : null}
                      {sd.contentType ? (
                        <InfoRow
                          label="Content-Type"
                          value={(sd.contentType.split(";")[0] ?? sd.contentType).trim()}
                          warn={!sd.contentType.includes("text/event-stream")}
                        />
                      ) : null}
                      {sd.headersMs != null ? (
                        <InfoRow label="Headers in" value={`${sd.headersMs}ms`} />
                      ) : null}
                      {sd.firstTokenMs != null ? (
                        <InfoRow label="First token in" value={`${sd.firstTokenMs}ms`} />
                      ) : null}
                      <InfoRow
                        label="Tokens received"
                        value={String(sd.tokenCount)}
                        warn={sd.tokenCount === 0 && sd.returnValue === "ok"}
                      />
                      <InfoRow
                        label="Done arrived"
                        value={sd.doneArrived ? "yes" : "no"}
                        warn={!sd.doneArrived && sd.returnValue === "ok"}
                      />
                      <InfoRow
                        label="Result"
                        value={sd.returnValue}
                        warn={sd.returnValue !== "ok"}
                      />
                      <InfoRow
                        label="Fell back to /chat"
                        value={sd.fallbackCalled ? "yes" : "no"}
                        warn={sd.fallbackCalled}
                      />
                      <Text style={{ color: c.mutedForeground, fontSize: 10, marginTop: 2 }}>
                        Captured {new Date(sd.capturedAt).toLocaleTimeString()}
                      </Text>
                    </View>
                  );
                })()}
              </View>
              {planSyncMessage ? (
                <Text style={{ color: "#f87171", fontSize: 12, lineHeight: 18 }}>
                  {planSyncMessage}
                </Text>
              ) : null}
              <Button
                label={diagLoading ? "Testing Ora chat…" : "Test Ora chat"}
                onPress={() => void runDiagnostics()}
                disabled={diagLoading}
                full
              />
              {diagSteps.length > 0 && (
                <View style={{ gap: 8 }}>
                  {diagSteps.map((step) => (
                    <DiagStepRow key={step.id} step={step} />
                  ))}
                  {!diagLoading && (
                    <Text
                      style={{
                        color: anyFail ? "#f87171" : allOk ? "#4ade80" : c.mutedForeground,
                        fontSize: 13,
                        textAlign: "center",
                        marginTop: 4,
                        fontFamily: "Inter_600SemiBold",
                      }}
                    >
                      {anyFail
                        ? "One or more steps failed — see details above."
                        : allOk
                          ? "All checks passed."
                          : "Check in progress…"}
                    </Text>
                  )}
                </View>
              )}
            </View>
          )}

          {/* ── Account sync sub-view ────────────────────────────────────── */}
          {aboutView === "account-sync" && (
            <View style={{ gap: 12 }}>
              {acctLocalSignedIn !== null && (
                <View style={{ gap: 4 }}>
                  <InfoRow label="Local signed in" value={acctLocalSignedIn ? "yes" : "no"} />
                  {acctLocalSignedIn && (
                    <InfoRow
                      label="Token present"
                      value={
                        acctTokenPresent === null ? "checking" : acctTokenPresent ? "yes" : "no"
                      }
                      warn={acctTokenPresent === false}
                    />
                  )}
                  {acctDiag && (
                    <InfoRow
                      label="Server recognized"
                      value={acctDiag.identity.clerkUserIdLast4 ? "yes" : "no"}
                      warn={acctLocalSignedIn && !acctDiag.identity.clerkUserIdLast4}
                    />
                  )}
                </View>
              )}
              {acctDiag ? (
                <View style={{ gap: 6 }}>
                  <InfoRow
                    label="User fingerprint"
                    value={acctDiag.identity.userIdHash || "anonymous"}
                  />
                  <InfoRow
                    label="Account id ending"
                    value={
                      acctDiag.identity.clerkUserIdLast4
                        ? `…${acctDiag.identity.clerkUserIdLast4}`
                        : "—"
                    }
                  />
                  <InfoRow label="Email" value={acctDiag.identity.email ?? "anonymous"} />
                  <InfoRow label="Billing tier" value={planLabel(acctDiag.billing.billingTier)} />
                  <InfoRow
                    label="Chat tier"
                    value={`${planLabel(acctDiag.chatSession.tier)}${acctDiag.chatSession.isPaid ? " (paid)" : ""}`}
                    warn={acctTierMismatch}
                  />
                  <InfoRow
                    label="Public session tier"
                    value={
                      acctPublicSessionTier !== null
                        ? `${planLabel(acctPublicSessionTier)}${acctPublicSessionIsPaid ? " (paid)" : ""}`
                        : "—"
                    }
                  />
                  <InfoRow
                    label="Local session tier"
                    value={acctLocalSessionTier !== null ? planLabel(acctLocalSessionTier) : "—"}
                    warn={acctLocalSessionMismatch}
                  />
                  <InfoRow
                    label="Session authenticated"
                    value={acctSessionAuthenticated ?? "—"}
                    warn={acctLocalSessionMismatch}
                  />
                  <InfoRow
                    label="Ora session auth"
                    value={
                      acctDiag.identity.clerkUserIdLast4
                        ? acctDiag.chatSession.isPaid
                          ? "authenticated (paid)"
                          : "authenticated (free)"
                        : "anonymous"
                    }
                    warn={!!acctLocalSignedIn && !acctDiag.identity.clerkUserIdLast4}
                  />
                  <InfoRow label="Conversations" value={String(acctDiag.counts.conversations)} />
                  <InfoRow label="Projects" value={String(acctDiag.counts.projects)} />
                  <InfoRow
                    label="Saved memories"
                    value={String(acctDiag.counts.userLevelMemories)}
                  />
                  <InfoRow
                    label="Project memories"
                    value={String(acctDiag.counts.projectMemories)}
                  />
                  <InfoRow label="Assets" value={String(acctDiag.counts.assets)} />
                  <InfoRow label="Support tickets" value={String(acctDiag.counts.supportTickets)} />
                  <InfoRow label="API host" value={acctDiag.api.host ?? "—"} />
                  <InfoRow label="Environment" value={acctDiag.api.environment ?? "—"} />
                </View>
              ) : (
                <View
                  style={{
                    backgroundColor: c.muted,
                    borderRadius: c.radius,
                    paddingHorizontal: 14,
                    paddingVertical: 12,
                  }}
                >
                  <Text style={{ color: c.mutedForeground, fontSize: 13, lineHeight: 18 }}>
                    {acctError
                      ? `Could not load account sync: ${acctError}`
                      : "Run the check to compare this device against your website account."}
                  </Text>
                </View>
              )}
              {acctWarnMessage ? (
                <Text style={{ color: "#f87171", fontSize: 12, lineHeight: 18 }}>
                  {acctWarnMessage}
                </Text>
              ) : null}
              <Button
                label={acctLoading ? "Checking account sync…" : "Check account sync"}
                onPress={() => void runAccountCheck()}
                disabled={acctLoading}
                full
              />
            </View>
          )}

          {/* ── Legal & Privacy sub-view ─────────────────────────────────── */}
          {aboutView === "legal" && (
            <View style={{ gap: 16 }}>
              {LEGAL_SECTIONS.map(({ heading, body }) => (
                <View key={heading} style={{ gap: 4 }}>
                  <Text
                    style={{
                      color: c.foreground,
                      fontFamily: "Inter_600SemiBold",
                      fontSize: 13,
                    }}
                  >
                    {heading}
                  </Text>
                  <Text style={{ color: c.mutedForeground, fontSize: 13, lineHeight: 20 }}>
                    {body}
                  </Text>
                </View>
              ))}
            </View>
          )}
        </SectionCard>
      </ScrollView>
    </View>
  );
}
