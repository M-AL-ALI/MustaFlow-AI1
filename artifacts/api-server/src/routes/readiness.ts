// ─────────────────────────────────────────────────────────────────────────────
// Publish readiness — GET /api/projects/:id/publish-readiness?env=testing|production
//
// Returns automated pass/fail/warning checks for the publish gate.
// The frontend uses this to block publishing when required gates fail.
// ─────────────────────────────────────────────────────────────────────────────

import { Router, type IRouter } from "express";
import { eq, count } from "drizzle-orm";
import {
  db,
  projectsTable,
  projectFilesTable,
  projectVersionsTable,
  secretsTable,
} from "@workspace/db";
import { requireProjectOwnership } from "../lib/auth";

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

router.get(
  "/projects/:id/publish-readiness",
  requireProjectOwnership,
  async (req, res): Promise<void> => {
    const projectId = Number(req.params.id);
    const env = (req.query.env as string) || "testing";

    const isProduction = env === "production";

    const [project] = await db
      .select({ name: projectsTable.name, description: projectsTable.description })
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
          : "No files generated yet. Use the AI Builder to create your app.",
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
