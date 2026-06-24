import { useAuth, useUser } from "@clerk/expo";
import Constants from "expo-constants";
import { useRouter } from "expo-router";
import * as WebBrowser from "expo-web-browser";
import {
  Activity,
  CheckCircle2,
  Circle,
  CreditCard,
  Crown,
  ExternalLink,
  Info,
  Loader,
  LogOut,
  Mic,
  Monitor,
  Moon,
  Plus,
  ShieldAlert,
  Sun,
  User as UserIcon,
  Volume2,
  Wifi,
  XCircle,
} from "lucide-react-native";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { Alert, Pressable, ScrollView, Switch, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { ScreenHeader } from "@/components/ScreenHeader";
import { Button, Card, Pill } from "@/components/ui";
import { type ThemeOverride, useTheme } from "@/context/ThemeContext";
import { useColors } from "@/hooks/useColors";
import {
  API_BASE,
  getPaymentMethod,
  getOraUsage,
  getPreferences,
  getSubscription,
  openBillingPortal,
  startOraSubscriptionCheckout,
  startPaymentMethodSetup,
  updatePreferences,
} from "@/lib/api";
import type { BillingSubscription, OraUsage, PaymentMethodInfo } from "@/lib/types";

const APP_VERSION = Constants.expoConfig?.version ?? "1.0.0";
const APP_BUILD =
  Constants.expoConfig?.ios?.buildNumber ??
  (Constants.expoConfig?.android?.versionCode != null
    ? String(Constants.expoConfig.android.versionCode)
    : null);
const APP_VERSION_LABEL = APP_BUILD
  ? `Version ${APP_VERSION} (${APP_BUILD})`
  : `Version ${APP_VERSION}`;

const STREAMING_ENABLED = process.env.EXPO_PUBLIC_ORA_STREAMING_ENABLED === "true";

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

function planLabel(tier?: string | null): string {
  if (tier === "core") return "Core Pack";
  if (tier === "wave") return "Deep Wave";
  return "Free";
}

function renewalLabel(subscription: BillingSubscription | null): string {
  const raw = subscription?.currentPeriodEnd;
  if (!raw) return "Rolling usage window";
  const formatted = formatReset(raw);
  if (subscription?.cancelAtPeriodEnd) return `Access ends ${formatted}`;
  return `Renews ${formatted}`;
}

function cardLabel(pm: PaymentMethodInfo | null): string {
  if (!pm?.hasPaymentMethod) return "No payment method on file";
  const brand = pm.brand ? pm.brand[0]?.toUpperCase() + pm.brand.slice(1) : "Card";
  return `${brand} ending in ${pm.last4 ?? "----"}`;
}

const BILLING_RETURN_URL = `${API_BASE}/ora/settings`;

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

/* ── Helpers ─────────────────────────────────────────────────────────────── */

function fetchWithTimeout(url: string, init: RequestInit, ms: number): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  return fetch(url, { ...init, signal: ctrl.signal }).finally(() => clearTimeout(timer));
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
        <Text
          style={{
            color: c.foreground,
            fontSize: 13,
            fontFamily: "Inter_500Medium",
            flex: 1,
          }}
        >
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

/* ── Main screen ─────────────────────────────────────────────────────────── */

export default function SettingsScreen() {
  const c = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { signOut, getToken, isSignedIn } = useAuth();
  const { user } = useUser();
  const { themeOverride, setThemeOverride } = useTheme();

  const [voiceLang, setVoiceLangState] = useState("en");
  const [autoReadReplies, setAutoReadReplies] = useState(false);
  const [subscription, setSubscription] = useState<BillingSubscription | null>(null);
  const [usage, setUsage] = useState<OraUsage | null>(null);
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethodInfo | null>(null);
  const [planAction, setPlanAction] = useState<"core" | "wave" | "portal" | "addpm" | null>(null);

  useEffect(() => {
    getPreferences()
      .then((p) => {
        if (p.voiceLang) setVoiceLangState(p.voiceLang);
        setAutoReadReplies(!!p.autoReadReplies);
      })
      .catch(() => {});
    if (isSignedIn) {
      getSubscription()
        .then(setSubscription)
        .catch(() => {});
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

  const openHostedBillingUrl = useCallback(async (remoteUrl?: string, fallback?: string) => {
    if (!remoteUrl) {
      Alert.alert("Billing unavailable", fallback ?? "Please try again.");
      return;
    }
    await WebBrowser.openBrowserAsync(remoteUrl);
  }, []);

  const startCheckout = useCallback(
    async (tier: "core" | "wave") => {
      setPlanAction(tier);
      try {
        const res = await startOraSubscriptionCheckout({
          tier,
          successUrl: BILLING_RETURN_URL,
          cancelUrl: BILLING_RETURN_URL,
        });
        await openHostedBillingUrl(res.checkoutUrl, res.message ?? res.error);
      } catch (err) {
        Alert.alert("Could not open checkout", err instanceof Error ? err.message : "Try again.");
      } finally {
        setPlanAction(null);
      }
    },
    [openHostedBillingUrl],
  );

  const openPortal = useCallback(async () => {
    setPlanAction("portal");
    try {
      const res = await openBillingPortal({ returnUrl: BILLING_RETURN_URL });
      await openHostedBillingUrl(res.url, res.error);
    } catch (err) {
      Alert.alert("Could not open billing", err instanceof Error ? err.message : "Try again.");
    } finally {
      setPlanAction(null);
    }
  }, [openHostedBillingUrl]);

  const addPaymentMethod = useCallback(async () => {
    setPlanAction("addpm");
    try {
      const res = await startPaymentMethodSetup({ returnUrl: BILLING_RETURN_URL });
      await openHostedBillingUrl(res.url, res.error);
    } catch (err) {
      Alert.alert("Could not open card setup", err instanceof Error ? err.message : "Try again.");
    } finally {
      setPlanAction(null);
    }
  }, [openHostedBillingUrl]);

  /* ── Diagnostics ───────────────────────────────────────────────────────── */

  const [diagSteps, setDiagSteps] = useState<DiagStep[]>([]);
  const [diagLoading, setDiagLoading] = useState(false);
  const [diagPlanSync, setDiagPlanSync] = useState<DiagPlanSync>(INITIAL_PLAN_SYNC);
  const diagRunningRef = useRef(false);

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

    const jsonHeaders: HeadersInit = {
      "Content-Type": "application/json",
      ...authHeaders,
    };

    /* Step 1 — Transport: any HTTP response proves connectivity */
    updateStep("transport", { status: "running" });
    try {
      const r = await fetchWithTimeout(
        `${API_BASE}/api/public-ai/session`,
        { method: "GET", headers: authHeaders },
        8000,
      );
      if (r.status < 500) {
        updateStep("transport", {
          status: "ok",
          httpStatus: r.status,
          detail: "Server reachable",
        });
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
      const name = err instanceof Error ? err.name : "Error";
      const msg = err instanceof Error ? err.message : String(err);
      updateStep("transport", {
        status: "fail",
        errorMsg: `${name}: ${msg}`,
      });
    }

    /* Step 2 — Session */
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
      const name = err instanceof Error ? err.name : "Error";
      const msg = err instanceof Error ? err.message : String(err);
      updateStep("session", { status: "fail", errorMsg: `${name}: ${msg}` });
    }

    /* Step 3 — Chat */
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
      const name = err instanceof Error ? err.name : "Error";
      const msg = err instanceof Error ? err.message : String(err);
      updateStep("chat", { status: "fail", errorMsg: `${name}: ${msg}` });
    }

    /* Step 4 — Streaming (if enabled) */
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
          const name = err instanceof Error ? err.name : "Error";
          const msg = err instanceof Error ? err.message : String(err);
          updateStep("stream", { status: "fail", errorMsg: `${name}: ${msg}` });
        }
      }
    }

    setDiagLoading(false);
    diagRunningRef.current = false;
  }, [getToken, updateStep]);

  /* ── Render ────────────────────────────────────────────────────────────── */

  const THEME_OPTIONS: { value: ThemeOverride; label: string; Icon: typeof Sun }[] = [
    { value: "system", label: "System", Icon: Monitor },
    { value: "light", label: "Light", Icon: Sun },
    { value: "dark", label: "Dark", Icon: Moon },
  ];

  const allOk = diagSteps.length > 0 && diagSteps.every((s) => s.status === "ok");
  const anyFail = diagSteps.some((s) => s.status === "fail");
  const currentTier = subscription?.tier ?? "free";
  const isPaid = currentTier === "core" || currentTier === "wave";
  const canUpgradeToCore = currentTier !== "core" && currentTier !== "wave";
  const canUpgradeToWave = currentTier !== "wave";
  const signedInEmail =
    user?.primaryEmailAddress?.emailAddress ?? user?.emailAddresses?.[0]?.emailAddress ?? "unknown";
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
        {/* Appearance */}
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

        {/* Voice input */}
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

        {/* Read replies aloud */}
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

        {/* Plan + Usage + Account — require sign-in */}
        {!isSignedIn && (
          <SectionCard
            icon={CreditCard}
            title="Account & Plan"
            description="Sign in to view your subscription, usage, and account details."
          >
            <Button label="Sign in" onPress={() => router.push("/sign-in")} full />
          </SectionCard>
        )}
        {isSignedIn && (
          <>
            {/* Plan */}
            <SectionCard
              icon={CreditCard}
              title="Plan & billing"
              description="Ora plan, renewal, upgrades, and payment method. These actions use the same hosted billing flows as the website."
            >
              <View style={{ gap: 10 }}>
                <View
                  style={{
                    backgroundColor: c.muted,
                    borderRadius: c.radius,
                    paddingHorizontal: 14,
                    paddingVertical: 12,
                    gap: 5,
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
                      style={{
                        color: c.foreground,
                        fontFamily: "Inter_700Bold",
                        fontSize: 17,
                      }}
                    >
                      {planLabel(currentTier)}
                    </Text>
                    {subscription?.status && (
                      <Text style={{ color: c.mutedForeground, fontSize: 13 }}>
                        {subscription.status}
                      </Text>
                    )}
                  </View>
                  <Text style={{ color: c.mutedForeground, fontSize: 13 }}>
                    {renewalLabel(subscription)}
                  </Text>
                </View>

                <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
                  {canUpgradeToCore && (
                    <Button
                      label="Upgrade to Core Pack"
                      icon={Crown}
                      variant="secondary"
                      loading={planAction === "core"}
                      disabled={planAction !== null}
                      onPress={() => void startCheckout("core")}
                    />
                  )}
                  {canUpgradeToWave && (
                    <Button
                      label="Upgrade to Deep Wave"
                      icon={Crown}
                      variant="secondary"
                      loading={planAction === "wave"}
                      disabled={planAction !== null}
                      onPress={() => void startCheckout("wave")}
                    />
                  )}
                  {isPaid && (
                    <Button
                      label="Manage Ora plan"
                      icon={ExternalLink}
                      loading={planAction === "portal"}
                      disabled={planAction !== null}
                      onPress={() => void openPortal()}
                    />
                  )}
                </View>

                <View
                  style={{
                    backgroundColor: c.muted,
                    borderRadius: c.radius,
                    paddingHorizontal: 14,
                    paddingVertical: 12,
                    gap: 8,
                  }}
                >
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                    <CreditCard size={17} color={c.accentForeground} />
                    <Text
                      style={{
                        color: c.foreground,
                        fontFamily: "Inter_600SemiBold",
                        fontSize: 14,
                      }}
                    >
                      {cardLabel(paymentMethod)}
                    </Text>
                  </View>
                  {paymentMethod?.status === "expired" && (
                    <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                      <ShieldAlert size={15} color={c.destructive} />
                      <Text style={{ color: c.destructive, fontSize: 12, flex: 1 }}>
                        This payment method is expired. Update it to keep your plan active.
                      </Text>
                    </View>
                  )}
                  {paymentMethod?.hasPaymentMethod &&
                  paymentMethod.expMonth &&
                  paymentMethod.expYear ? (
                    <Text style={{ color: c.mutedForeground, fontSize: 12 }}>
                      Expires {String(paymentMethod.expMonth).padStart(2, "0")}/
                      {paymentMethod.expYear}
                    </Text>
                  ) : null}
                  <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
                    <Button
                      label={
                        paymentMethod?.hasPaymentMethod
                          ? "Change payment method"
                          : "Add payment method"
                      }
                      icon={paymentMethod?.hasPaymentMethod ? CreditCard : Plus}
                      variant="secondary"
                      loading={planAction === "addpm"}
                      disabled={planAction !== null}
                      onPress={() => void addPaymentMethod()}
                    />
                    {paymentMethod?.hasPaymentMethod && (
                      <Button
                        label="Manage billing"
                        icon={ExternalLink}
                        variant="ghost"
                        loading={planAction === "portal"}
                        disabled={planAction !== null}
                        onPress={() => void openPortal()}
                      />
                    )}
                  </View>
                </View>

                <Text style={{ color: c.mutedForeground, fontSize: 12, lineHeight: 18 }}>
                  Public App Store release still needs a final IAP/store-compliance decision.
                  Internal testing can use the same hosted website billing flows for parity review.
                </Text>
              </View>
            </SectionCard>

            {/* Usage */}
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

            {/* Account */}
            <SectionCard
              icon={UserIcon}
              title="Account"
              description="Your profile and sign-in details."
            >
              <View style={{ gap: 4 }}>
                <Text style={{ color: c.foreground, fontFamily: "Inter_500Medium", fontSize: 15 }}>
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
          </>
        )}

        {/* About */}
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

        {/* Diagnostics */}
        <SectionCard
          icon={Wifi}
          title="Diagnostics"
          description="Step-by-step connectivity and chat-path check."
        >
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
          </View>

          {planSyncMessage ? (
            <Text
              style={{
                color: "#f87171",
                fontSize: 12,
                lineHeight: 18,
                marginTop: 2,
              }}
            >
              {planSyncMessage}
            </Text>
          ) : null}

          <Button
            label={diagLoading ? "Running diagnostics…" : "Run diagnostics"}
            onPress={runDiagnostics}
            disabled={diagLoading}
            full
          />

          {diagSteps.length > 0 && (
            <View style={{ gap: 8, marginTop: 4 }}>
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
        </SectionCard>
      </ScrollView>
    </View>
  );
}
