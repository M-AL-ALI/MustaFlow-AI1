import { previewSecretDisposition } from "./project-secret-display-model";
import type { SecretEntry } from "@workspace/api-client-react";

export interface MobileModule {
  id: string;
  name: string;
  provider: string;
  description: string;
  requiredSecrets: readonly string[];
  packageDependencies: readonly string[];
}
export type ModuleSecret = Pick<
  SecretEntry,
  "id" | "projectId" | "name" | "environment" | "isPreviewSafe" | "minRole"
>;
export type ModuleRequest = "setup" | "check" | "remove";
export const MOBILE_MODULES: readonly MobileModule[] = [
  {
    id: "auth",
    name: "Authentication",
    provider: "Clerk",
    description: "User sign-in, sign-up, and session management.",
    requiredSecrets: ["CLERK_PUBLISHABLE_KEY"],
    packageDependencies: ["@clerk/clerk-expo", "expo-secure-store"],
  },
  {
    id: "payments",
    name: "In-App Purchases",
    provider: "RevenueCat",
    description: "Subscription paywalls, purchase flows, and entitlement checks.",
    requiredSecrets: ["REVENUECAT_API_KEY"],
    packageDependencies: ["@revenuecat/purchases-react-native"],
  },
  {
    id: "push",
    name: "Push Notifications",
    provider: "Expo Notifications",
    description: "FCM and APNS push notifications with registration flow.",
    requiredSecrets: [],
    packageDependencies: ["expo-notifications", "expo-device"],
  },
  {
    id: "realtime-db",
    name: "Real-time Database",
    provider: "Supabase",
    description: "Typed queries, real-time subscriptions, and Row Level Security.",
    requiredSecrets: ["SUPABASE_URL", "SUPABASE_ANON_KEY"],
    packageDependencies: ["@supabase/supabase-js"],
  },
  {
    id: "analytics",
    name: "Analytics",
    provider: "Amplitude",
    description: "Event tracking wired to key user actions.",
    requiredSecrets: ["AMPLITUDE_API_KEY"],
    packageDependencies: ["@amplitude/analytics-react-native"],
  },
  {
    id: "deep-links",
    name: "Deep Links",
    provider: "Expo Linking",
    description: "Share links, invites, and referral flows.",
    requiredSecrets: [],
    packageDependencies: ["expo-linking"],
  },
  {
    id: "offline",
    name: "Offline Support",
    provider: "AsyncStorage + SQLite",
    description: "Local caching and SQLite for offline-first apps.",
    requiredSecrets: [],
    packageDependencies: ["@react-native-async-storage/async-storage", "expo-sqlite"],
  },
  {
    id: "camera-media",
    name: "Camera & Media",
    provider: "Expo Camera",
    description: "Camera capture, photo/video picking, and media upload.",
    requiredSecrets: [],
    packageDependencies: ["expo-camera", "expo-image-picker"],
  },
];

// Presence is a prerequisite, not provider authentication or working-code proof.
export function moduleSecretNames(projectId: number, secrets: readonly ModuleSecret[]) {
  return new Set(
    secrets
      .filter((secret) => previewSecretDisposition(secret, projectId).eligible)
      .map((secret) => secret.name),
  );
}
export function missingModuleSecrets(
  mod: MobileModule,
  projectId: number,
  secrets: readonly ModuleSecret[],
) {
  const names = moduleSecretNames(projectId, secrets);
  return mod.requiredSecrets.filter((name) => !names.has(name));
}
// An existing but ineligible key needs review, not a duplicate write or a role downgrade.
export function blockedModuleSecrets(
  mod: MobileModule,
  projectId: number,
  secrets: readonly ModuleSecret[],
) {
  const missing = missingModuleSecrets(mod, projectId, secrets);
  return missing.filter((name) =>
    secrets.some((secret) => secret.projectId === projectId && secret.name === name),
  );
}
export function moduleRequestText(mod: MobileModule, intent: ModuleRequest) {
  if (intent === "remove")
    return (
      "Remove the " +
      mod.name +
      " (" +
      mod.provider +
      ") integration from this app's code. Preserve provider accounts, purchased services, databases, and stored secrets. Remove only code and dependencies exclusive to this integration; keep shared code and dependencies. Test the app and report what changed, with evidence and any remaining steps."
    );
  if (intent === "check")
    return (
      "Check the " +
      mod.name +
      " (" +
      mod.provider +
      ") integration in this app. Inspect its wiring and run appropriate non-destructive checks in the development environment. Do not expose secret values, spend money, or send real notifications. Report the evidence, failures, and anything untested; a prior build report is not proof it works."
    );
  const keys = mod.requiredSecrets.length
    ? " Read the preview-eligible development or testing keys named " +
      mod.requiredSecrets.join(", ") +
      " from this project's secret store; never print their values or substitute production keys."
    : "";
  return (
    "Set up " +
    mod.name +
    " (" +
    mod.provider +
    ") for this app." +
    keys +
    " Follow the provider's official Expo SDK patterns with correct initialization, typed hooks, loading states, and error handling. Reuse existing project structure and add only required dependencies. Check that all required keys are available before wiring. Run appropriate non-destructive development checks and report evidence and any blocked steps. Do not claim the integration works merely because code was generated."
  );
}
