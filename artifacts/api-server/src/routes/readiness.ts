// ─────────────────────────────────────────────────────────────────────────────
// Publish readiness — GET /api/projects/:id/publish-readiness?env=testing|production|ios|android
//
// Returns automated pass/fail/warning checks for the publish gate.
// The frontend uses this to block publishing when required gates fail.
// ─────────────────────────────────────────────────────────────────────────────

import { Router, type IRouter } from "express";
import { eq, count, and, desc } from "drizzle-orm";
import {
  db,
  projectsTable,
  projectFilesTable,
  projectVersionsTable,
  secretsTable,
  deploymentLogsTable,
  checkRunsTable,
} from "@workspace/db";
import type { CheckFinding } from "@workspace/db";
import { requireProjectOwnership } from "../lib/auth";

// ─── Security finding helpers ─────────────────────────────────────────────────

/** Stable key identifying a finding — used to match against dismissedFindingHashes. */
export function findingKey(f: CheckFinding): string {
  return `${f.file}:${f.line ?? 0}:${f.message}`;
}

/**
 * Check names that are considered security-relevant for the publish gate.
 * Only findings from these checks will block publishing.
 */
const SECURITY_CHECK_NAMES = new Set([
  "sast",
  "secret-scan",
  "secret-leak",
  "secrets",
  "security",
  "cdn-security",
  "dependency-audit",
  "vulnerability-scan",
]);

function isSecurityCheckName(checkName: string): boolean {
  const lower = checkName.toLowerCase();
  return (
    SECURITY_CHECK_NAMES.has(lower) ||
    lower.includes("security") ||
    lower.includes("secret") ||
    lower.includes("vuln") ||
    lower.includes("sast")
  );
}

/**
 * Query the most recent check run rows for a project and return all unresolved
 * critical (error-severity) findings from security-related checks only,
 * filtered against the project's dismissed list.
 */
export async function getUnresolvedCriticalFindings(
  projectId: number,
  dismissedHashes: string[],
): Promise<Array<{ checkName: string; finding: CheckFinding }>> {
  // Fetch the latest run per check name (ordered by ranAt desc, dedup by checkName).
  const rows = await db
    .select({
      checkName: checkRunsTable.checkName,
      findings: checkRunsTable.findings,
      ranAt: checkRunsTable.ranAt,
    })
    .from(checkRunsTable)
    .where(eq(checkRunsTable.projectId, projectId))
    .orderBy(desc(checkRunsTable.ranAt))
    .limit(200);

  // Keep only the most recent run per check name.
  const latestByName = new Map<string, { findings: CheckFinding[] }>();
  for (const row of rows) {
    if (!latestByName.has(row.checkName)) {
      latestByName.set(row.checkName, { findings: (row.findings as CheckFinding[]) ?? [] });
    }
  }

  const dismissed = new Set(dismissedHashes);
  const critical: Array<{ checkName: string; finding: CheckFinding }> = [];

  for (const [checkName, { findings }] of latestByName) {
    // Only count findings from security-related check runs
    if (!isSecurityCheckName(checkName)) continue;
    for (const f of findings) {
      if (f.severity === "error" && !dismissed.has(findingKey(f))) {
        critical.push({ checkName, finding: f });
      }
    }
  }

  return critical;
}

export type CheckStatus = "pass" | "fail" | "warning" | "info";
export type CheckSeverity = "blocking" | "warning" | "info";

export interface ReadinessCheck {
  id: string;
  label: string;
  description: string;
  status: CheckStatus;
  severity: CheckSeverity;
  message?: string;
}

export interface ReadinessResult {
  env: string;
  canPublish: boolean;
  checks: ReadinessCheck[];
}

const TEST_KEY_PATTERNS = [/^sk_test_/i, /^pk_test_/i, /^rk_test_/i, /test_key/i];
const PROD_KEY_PATTERNS = [/^sk_live_/i, /^pk_live_/i, /^rk_live_/i, /^live_/i];

function looksLikeTestKey(value: string): boolean {
  return TEST_KEY_PATTERNS.some((p) => p.test(value));
}
function looksLikeProdKey(value: string): boolean {
  return PROD_KEY_PATTERNS.some((p) => p.test(value));
}

const router: IRouter = Router();

// ─── Mobile store readiness (iOS / Android) ───────────────────────────────────

async function getMobileReadiness(
  projectId: number,
  platform: "ios" | "android",
): Promise<ReadinessResult> {
  const checks: ReadinessCheck[] = [];

  const [[filesRow], secrets, appJsonFile, successfulBuilds] = await Promise.all([
    db
      .select({ c: count() })
      .from(projectFilesTable)
      .where(eq(projectFilesTable.projectId, projectId)),
    db
      .select({ name: secretsTable.name })
      .from(secretsTable)
      .where(eq(secretsTable.projectId, projectId)),
    db
      .select({ content: projectFilesTable.content })
      .from(projectFilesTable)
      .where(
        and(eq(projectFilesTable.projectId, projectId), eq(projectFilesTable.path, "app.json")),
      )
      .limit(1),
    db
      .select({ id: deploymentLogsTable.id, status: deploymentLogsTable.status })
      .from(deploymentLogsTable)
      .where(
        and(
          eq(deploymentLogsTable.projectId, projectId),
          eq(deploymentLogsTable.env, `eas-${platform}`),
          eq(deploymentLogsTable.status, "passed"),
        ),
      )
      .limit(1),
  ]);

  const fileCount = Number(filesRow?.c ?? 0);
  const secretNames = new Set(secrets.map((s) => s.name));

  // Parse app.json if present
  let appJson: Record<string, unknown> | null = null;
  if (appJsonFile.length > 0) {
    try {
      appJson = JSON.parse(appJsonFile[0].content) as Record<string, unknown>;
    } catch {
      /* malformed app.json — treat as missing */
    }
  }

  // ── Check 1: has generated app files (BLOCKING) ───────────────────────────
  checks.push({
    id: "mobile_has_files",
    label: "App has generated files",
    description: "At least one file must be generated before store submission.",
    severity: "blocking",
    status: fileCount > 0 ? "pass" : "fail",
    message:
      fileCount > 0
        ? `${fileCount} file(s) ready`
        : "No files generated yet. Use NabuFlow to create your app first.",
  });

  // ── Check 2: EAS_ACCESS_TOKEN secret configured (BLOCKING) ───────────────
  const hasEasToken = secretNames.has("EAS_ACCESS_TOKEN");
  checks.push({
    id: "mobile_eas_token",
    label: "EAS Access Token configured",
    description:
      "An Expo Application Services access token is required to trigger cloud builds and submit to stores.",
    severity: "blocking",
    status: hasEasToken ? "pass" : "fail",
    message: hasEasToken
      ? "EAS_ACCESS_TOKEN secret is set"
      : "Add your EAS_ACCESS_TOKEN in the Secrets tab of this project.",
  });

  if (platform === "ios") {
    // ── Check 3 (iOS): Bundle ID configured in app.json (BLOCKING) ───────
    const expo = appJson?.expo as Record<string, unknown> | undefined;
    const bundleId = expo?.ios
      ? (expo.ios as Record<string, unknown>)?.bundleIdentifier
      : undefined;
    const hasBundleId =
      typeof bundleId === "string" && bundleId.length > 0 && bundleId !== "com.example.app";
    checks.push({
      id: "ios_bundle_id",
      label: "Bundle ID registered",
      description:
        "A unique bundle identifier (e.g. com.yourcompany.appname) must be set in your app config.",
      severity: "blocking",
      status: hasBundleId ? "pass" : "fail",
      message: hasBundleId
        ? `Bundle ID: ${String(bundleId)}`
        : appJson
          ? `Current value: ${String(bundleId ?? "not set")} — replace with a unique bundle ID in Mobile Settings.`
          : "Build the app first so app.json is generated, then set the bundle ID in Mobile Settings.",
    });

    // ── Check 4 (iOS): Apple Developer account secrets (BLOCKING) ─────────
    const hasAppleId = secretNames.has("EXPO_APPLE_ID");
    const hasAppleTeam = secretNames.has("EXPO_APPLE_TEAM_ID");
    const hasAppleCreds = hasAppleId && hasAppleTeam;
    checks.push({
      id: "ios_apple_creds",
      label: "Apple Developer credentials configured",
      description:
        "EXPO_APPLE_ID (your Apple ID email) and EXPO_APPLE_TEAM_ID are required for distribution signing.",
      severity: "blocking",
      status: hasAppleCreds ? "pass" : "fail",
      message: hasAppleCreds
        ? "EXPO_APPLE_ID and EXPO_APPLE_TEAM_ID are set"
        : [
            !hasAppleId ? "EXPO_APPLE_ID missing" : null,
            !hasAppleTeam ? "EXPO_APPLE_TEAM_ID missing" : null,
          ]
            .filter(Boolean)
            .join(", ") + ". Add them in the Secrets tab.",
    });

    // ── Check 5 (iOS): Successful EAS iOS build exists (BLOCKING) ─────────
    const hasBuild = successfulBuilds.length > 0;
    checks.push({
      id: "ios_successful_build",
      label: "Successful iOS build completed",
      description:
        "A passing EAS iOS cloud build is required before submitting to TestFlight or the App Store.",
      severity: "blocking",
      status: hasBuild ? "pass" : "fail",
      message: hasBuild
        ? "At least one successful iOS build found"
        : "Trigger an iOS build from the EAS Build panel above and wait for it to complete.",
    });

    // ── Check 6 (iOS): App icon present (WARNING) ────────────────────────
    const hasIcon = appJson !== null && Boolean((appJson.expo as Record<string, unknown>)?.icon);
    checks.push({
      id: "ios_app_icon",
      label: "App icon configured",
      description: "A 1024×1024 PNG app icon is required for App Store submission.",
      severity: "warning",
      status: hasIcon ? "pass" : "warning",
      message: hasIcon
        ? "Icon path present in app.json"
        : "Add an icon path in Mobile Settings or directly in app.json.",
    });
  } else {
    // ── Check 3 (Android): Package name configured in app.json (BLOCKING) ─
    const expo = appJson?.expo as Record<string, unknown> | undefined;
    const packageName = expo?.android
      ? (expo.android as Record<string, unknown>)?.package
      : undefined;
    const hasPackageName =
      typeof packageName === "string" &&
      packageName.length > 0 &&
      packageName !== "com.example.app";
    checks.push({
      id: "android_package_name",
      label: "Package name registered",
      description:
        "A unique package name (e.g. com.yourcompany.appname) must be set in your app config.",
      severity: "blocking",
      status: hasPackageName ? "pass" : "fail",
      message: hasPackageName
        ? `Package name: ${String(packageName)}`
        : appJson
          ? `Current value: ${String(packageName ?? "not set")} — replace with a unique package name in Mobile Settings.`
          : "Build the app first so app.json is generated, then set the package name in Mobile Settings.",
    });

    // ── Check 4 (Android): Keystore / service account secrets (BLOCKING) ──
    const hasKeystore =
      secretNames.has("EXPO_ANDROID_KEYSTORE") ||
      secretNames.has("EXPO_ANDROID_KEYSTORE_PASSWORD") ||
      secretNames.has("GOOGLE_SERVICES_JSON");
    const hasPlayAccount = secretNames.has("GOOGLE_PLAY_SERVICE_ACCOUNT_JSON");
    checks.push({
      id: "android_keystore",
      label: "Android keystore configured",
      description:
        "An upload keystore (EXPO_ANDROID_KEYSTORE_PASSWORD or GOOGLE_SERVICES_JSON) is required to sign your release build.",
      severity: "blocking",
      status: hasKeystore ? "pass" : "fail",
      message: hasKeystore
        ? "Android signing secrets found"
        : "Add EXPO_ANDROID_KEYSTORE_PASSWORD or GOOGLE_SERVICES_JSON in the Secrets tab.",
    });

    checks.push({
      id: "android_play_account",
      label: "Google Play service account configured",
      description:
        "GOOGLE_PLAY_SERVICE_ACCOUNT_JSON (JSON key with releasemanager role) is required to upload to Google Play.",
      severity: "blocking",
      status: hasPlayAccount ? "pass" : "fail",
      message: hasPlayAccount
        ? "GOOGLE_PLAY_SERVICE_ACCOUNT_JSON is set"
        : "Add GOOGLE_PLAY_SERVICE_ACCOUNT_JSON in the Secrets tab. Download it from Google Play Console under Setup > API access.",
    });

    // ── Check 5 (Android): Successful EAS Android build exists (BLOCKING) ─
    const hasBuild = successfulBuilds.length > 0;
    checks.push({
      id: "android_successful_build",
      label: "Successful Android build completed",
      description:
        "A passing EAS Android cloud build (.aab) is required before uploading to Google Play.",
      severity: "blocking",
      status: hasBuild ? "pass" : "fail",
      message: hasBuild
        ? "At least one successful Android build found"
        : "Trigger an Android build from the EAS Build panel above and wait for it to complete.",
    });

    // ── Check 6 (Android): App icon present (WARNING) ────────────────────
    const hasIcon = appJson !== null && Boolean((appJson.expo as Record<string, unknown>)?.icon);
    checks.push({
      id: "android_app_icon",
      label: "App icon configured",
      description: "A 512×512 PNG app icon is required for Google Play submission.",
      severity: "warning",
      status: hasIcon ? "pass" : "warning",
      message: hasIcon
        ? "Icon path present in app.json"
        : "Add an icon path in Mobile Settings or directly in app.json.",
    });
  }

  const blockingFailed = checks.some((c) => c.severity === "blocking" && c.status === "fail");

  return {
    env: platform,
    canPublish: !blockingFailed,
    checks,
  };
}

router.get(
  "/projects/:id/publish-readiness",
  requireProjectOwnership,
  async (req, res): Promise<void> => {
    const projectId = Number(req.params.id);
    const env = (req.query.env as string) || "testing";

    // ── Mobile store readiness paths ─────────────────────────────────────────
    if (env === "ios" || env === "android") {
      const result = await getMobileReadiness(projectId, env);
      res.json(result);
      return;
    }

    // ── Web publish readiness (testing / production) ─────────────────────────
    const isProduction = env === "production";

    const [project] = await db
      .select({
        name: projectsTable.name,
        description: projectsTable.description,
        blockPublishOnCritical: projectsTable.blockPublishOnCritical,
        dismissedFindingHashes: projectsTable.dismissedFindingHashes,
      })
      .from(projectsTable)
      .where(eq(projectsTable.id, projectId));

    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }

    const [[filesRow], [versionsRow], secrets] = await Promise.all([
      db
        .select({ c: count() })
        .from(projectFilesTable)
        .where(eq(projectFilesTable.projectId, projectId)),
      db
        .select({ c: count() })
        .from(projectVersionsTable)
        .where(eq(projectVersionsTable.projectId, projectId)),
      db
        .select({
          name: secretsTable.name,
          valueEncrypted: secretsTable.valueEncrypted,
          environment: secretsTable.environment,
        })
        .from(secretsTable)
        .where(eq(secretsTable.projectId, projectId)),
    ]);

    const fileCount = Number(filesRow?.c ?? 0);
    const versionCount = Number(versionsRow?.c ?? 0);

    const checks: ReadinessCheck[] = [];

    // ── Check 1: has generated files (BLOCKING) ──────────────────────────────
    checks.push({
      id: "has_files",
      label: "App has generated files",
      description: "At least one file must be generated before publishing.",
      severity: "blocking",
      status: fileCount > 0 ? "pass" : "fail",
      message:
        fileCount > 0
          ? `${fileCount} file(s) ready`
          : "No files generated yet. Use NabuFlow to create your app.",
    });

    // ── Check 2: has rollback point (BLOCKING for production) ─────────────────
    checks.push({
      id: "has_rollback_point",
      label: "Rollback snapshot exists",
      description: "A saved version is required so you can roll back if something goes wrong.",
      severity: isProduction ? "blocking" : "warning",
      status: versionCount > 0 ? "pass" : isProduction ? "fail" : "warning",
      message:
        versionCount > 0
          ? `${versionCount} snapshot(s) available`
          : "No version snapshots yet. Build the app to create one.",
    });

    // ── Check 3: no test-looking keys in production secrets ───────────────────
    if (isProduction) {
      const prodSecrets = secrets.filter((s) => s.environment === "production");
      const testKeysInProd = prodSecrets.filter(
        (s) => looksLikeTestKey(s.valueEncrypted) || looksLikeTestKey(s.name),
      );
      checks.push({
        id: "no_test_keys_in_production",
        label: "No test keys in production secrets",
        description: "Production secrets must not contain test-mode API keys.",
        severity: "blocking",
        status: testKeysInProd.length === 0 ? "pass" : "fail",
        message:
          testKeysInProd.length === 0
            ? "All production secrets look like live keys"
            : `${testKeysInProd.length} secret(s) appear to use test keys: ${testKeysInProd.map((s) => s.name).join(", ")}`,
      });
    }

    // ── Check 4: no prod-looking keys in testing secrets (WARNING) ────────────
    const testingSecrets = secrets.filter((s) => s.environment === "testing");
    const prodKeysInTest = testingSecrets.filter(
      (s) => looksLikeProdKey(s.valueEncrypted) || looksLikeProdKey(s.name),
    );
    if (testingSecrets.length > 0) {
      checks.push({
        id: "no_prod_keys_in_testing",
        label: "No production keys in testing secrets",
        description: "Testing environment should not reference live production API keys.",
        severity: "warning",
        status: prodKeysInTest.length === 0 ? "pass" : "warning",
        message:
          prodKeysInTest.length === 0
            ? "No production-mode keys found in testing environment"
            : `${prodKeysInTest.length} secret(s) in testing may be production keys: ${prodKeysInTest.map((s) => s.name).join(", ")}`,
      });
    }

    // ── Check 5: project has a real name (WARNING) ────────────────────────────
    const defaultNames = ["new project", "untitled", "my project"];
    const nameOk =
      project.name.trim().length > 0 && !defaultNames.includes(project.name.toLowerCase().trim());
    checks.push({
      id: "has_name",
      label: "Project has a meaningful name",
      description: "Give your project a real name before publishing.",
      severity: "warning",
      status: nameOk ? "pass" : "warning",
      message: nameOk
        ? `Name: "${project.name}"`
        : `Project is named "${project.name}" — consider renaming it in Manage.`,
    });

    // ── Check 6: project has a description (INFO) ─────────────────────────────
    checks.push({
      id: "has_description",
      label: "Project has a description",
      description: "A description helps with SEO and the published site metadata.",
      severity: "info",
      status: project.description && project.description.trim().length > 0 ? "pass" : "info",
      message: project.description
        ? "Description present"
        : "No description set. Add one in Manage or Published Site Settings.",
    });

    // ── Check 7: privacy policy link (WARNING for production) ─────────────────
    if (isProduction) {
      const latestPrivacyRuns = await db
        .select({ findings: checkRunsTable.findings, ranAt: checkRunsTable.ranAt })
        .from(checkRunsTable)
        .where(
          and(eq(checkRunsTable.projectId, projectId), eq(checkRunsTable.checkName, "privacy")),
        )
        .orderBy(desc(checkRunsTable.ranAt))
        .limit(1);

      const privacyFindings =
        (latestPrivacyRuns[0]?.findings as import("@workspace/db").CheckFinding[] | undefined) ??
        [];
      const noPrivacyLink = privacyFindings.some(
        (f) => f.message === "No privacy policy link found",
      );
      const hasTrackerWithoutConsent = privacyFindings.some(
        (f) => f.severity === "warning" && f.message.startsWith("Tracker loaded without consent"),
      );

      if (noPrivacyLink || hasTrackerWithoutConsent) {
        const messages: string[] = [];
        if (noPrivacyLink) messages.push("no privacy policy link found");
        if (hasTrackerWithoutConsent) messages.push("tracker(s) loaded without consent mechanism");
        checks.push({
          id: "privacy_compliance",
          label: "Privacy compliance",
          description:
            "Published apps should include a privacy policy link and load trackers only after user consent.",
          severity: "warning",
          status: "warning",
          message: `Privacy concerns: ${messages.join(", ")}. Add a privacy policy and cookie consent banner.`,
        });
      }
    }

    // ── Check 8: security findings gate (BLOCKING when blockPublishOnCritical is on) ─────
    if (project.blockPublishOnCritical) {
      const dismissed = (project.dismissedFindingHashes as string[] | null) ?? [];
      const criticalFindings = await getUnresolvedCriticalFindings(projectId, dismissed);
      const hasCritical = criticalFindings.length > 0;
      const findingMessages = criticalFindings
        .slice(0, 5)
        .map(({ checkName, finding }) => `[${checkName}] ${finding.file}: ${finding.message}`)
        .join("; ");

      checks.push({
        id: "no_critical_findings",
        label: "No unresolved critical security findings",
        description:
          "Publishing is blocked when critical (error-severity) security findings are open. Dismiss findings in the Quality tab or rebuild to fix them.",
        severity: "blocking",
        status: hasCritical ? "fail" : "pass",
        message: hasCritical
          ? `${criticalFindings.length} critical finding${criticalFindings.length !== 1 ? "s" : ""} must be resolved or dismissed: ${findingMessages}`
          : "No critical security findings.",
        ...(hasCritical
          ? {
              // Extra metadata for the frontend to render per-finding details
              criticalFindingCount: criticalFindings.length,
              criticalFindings: criticalFindings.slice(0, 10).map(({ checkName, finding }) => ({
                key: findingKey(finding),
                checkName,
                file: finding.file,
                line: finding.line,
                message: finding.message,
              })),
            }
          : {}),
      });
    }

    const blockingFailed = checks.some((c) => c.severity === "blocking" && c.status === "fail");

    const result: ReadinessResult = {
      env,
      canPublish: !blockingFailed,
      checks,
    };

    res.json(result);
  },
);

export default router;
