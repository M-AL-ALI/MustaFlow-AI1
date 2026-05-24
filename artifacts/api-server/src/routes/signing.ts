// ─────────────────────────────────────────────────────────────────────────────
// Signing key management routes
//
// GET    /api/projects/:id/signing              — return signing credential status (no raw values)
// POST   /api/projects/:id/signing/ios          — upload P12 cert + provisioning profile
// POST   /api/projects/:id/signing/android      — upload keystore + key metadata
// DELETE /api/projects/:id/signing/ios          — remove iOS signing credentials
// DELETE /api/projects/:id/signing/android      — remove Android signing credentials
//
// Credentials are stored as encrypted project secrets with reserved names
// prefixed by "_SIGN_" to distinguish them from user-configured API secrets.
// Raw values are never returned — only presence + metadata.
// ─────────────────────────────────────────────────────────────────────────────

import { Router, type IRouter } from "express";
import { and, eq, inArray } from "drizzle-orm";
import { db, secretsTable } from "@workspace/db";
import { requireProjectOwnership } from "../lib/auth";
import { encryptionService } from "../lib/encryption";
import { logger } from "../lib/logger";
import { z } from "zod";

const router: IRouter = Router();

// ── Reserved secret name constants ────────────────────────────────────────────

const IOS_CRED_NAMES = [
  "_SIGN_IOS_P12_CERT", // base64-encoded P12 certificate
  "_SIGN_IOS_P12_PASSWORD", // P12 password (plain text)
  "_SIGN_IOS_PROVISIONING", // base64-encoded .mobileprovision
  "_SIGN_IOS_TEAM_ID", // 10-char Apple Developer Team ID
] as const;

const ANDROID_CRED_NAMES = [
  "_SIGN_ANDROID_KEYSTORE", // base64-encoded JKS/PKCS12 keystore
  "_SIGN_ANDROID_KS_PASSWORD", // keystore password
  "_SIGN_ANDROID_KEY_ALIAS", // key alias inside the keystore
  "_SIGN_ANDROID_KEY_PASSWORD", // key password (may equal keystore password)
] as const;

type IosCredName = (typeof IOS_CRED_NAMES)[number];
type AndroidCredName = (typeof ANDROID_CRED_NAMES)[number];
type CredName = IosCredName | AndroidCredName;

// ── Validation schemas ────────────────────────────────────────────────────────

const IosSigningSchema = z.object({
  p12Base64: z.string().min(1, "P12 certificate (base64) is required"),
  p12Password: z.string().default(""),
  provisioningProfileBase64: z.string().min(1, "Provisioning profile (base64) is required"),
  teamId: z
    .string()
    .regex(/^[A-Z0-9]{10}$/, "Team ID must be exactly 10 alphanumeric characters")
    .optional(),
});

const AndroidSigningSchema = z.object({
  keystoreBase64: z.string().min(1, "Keystore (base64) is required"),
  keystorePassword: z.string().min(1, "Keystore password is required"),
  keyAlias: z.string().min(1, "Key alias is required"),
  keyPassword: z.string().default(""),
});

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Fetch all signing secrets for a project (returns a name→id map, never raw values). */
async function getSigningSecrets(
  projectId: number,
  names: readonly CredName[],
): Promise<Map<CredName, number>> {
  const rows = await db
    .select({ name: secretsTable.name, id: secretsTable.id })
    .from(secretsTable)
    .where(
      and(
        eq(secretsTable.projectId, projectId),
        inArray(secretsTable.name, names as unknown as string[]),
      ),
    );
  return new Map(rows.map((r) => [r.name as CredName, r.id]));
}

/** Upsert a single encrypted signing secret. */
async function upsertSigningSecret(
  projectId: number,
  name: CredName,
  value: string,
): Promise<void> {
  const encrypted = encryptionService.encrypt(value);
  const [existing] = await db
    .select({ id: secretsTable.id })
    .from(secretsTable)
    .where(and(eq(secretsTable.projectId, projectId), eq(secretsTable.name, name)))
    .limit(1);

  if (existing) {
    await db
      .update(secretsTable)
      .set({ valueEncrypted: encrypted, updatedAt: new Date() })
      .where(eq(secretsTable.id, existing.id));
  } else {
    await db.insert(secretsTable).values({
      projectId,
      name,
      valueEncrypted: encrypted,
      environment: "production",
      category: "api_key",
    });
  }
}

/** Delete signing secrets by name list. */
async function deleteSigningSecrets(projectId: number, names: readonly CredName[]): Promise<void> {
  await db
    .delete(secretsTable)
    .where(
      and(
        eq(secretsTable.projectId, projectId),
        inArray(secretsTable.name, names as unknown as string[]),
      ),
    );
}

// ── GET /api/projects/:id/signing ─────────────────────────────────────────────
router.get("/projects/:id/signing", requireProjectOwnership, async (req, res): Promise<void> => {
  const projectId = Number(req.params.id);
  if (!Number.isFinite(projectId)) {
    res.status(400).json({ error: "Invalid project id" });
    return;
  }

  const [iosSecrets, androidSecrets] = await Promise.all([
    getSigningSecrets(projectId, IOS_CRED_NAMES),
    getSigningSecrets(projectId, ANDROID_CRED_NAMES),
  ]);

  res.json({
    ios: {
      hasP12: iosSecrets.has("_SIGN_IOS_P12_CERT"),
      hasProvisioning: iosSecrets.has("_SIGN_IOS_PROVISIONING"),
      hasTeamId: iosSecrets.has("_SIGN_IOS_TEAM_ID"),
      configured: iosSecrets.has("_SIGN_IOS_P12_CERT") && iosSecrets.has("_SIGN_IOS_PROVISIONING"),
    },
    android: {
      hasKeystore: androidSecrets.has("_SIGN_ANDROID_KEYSTORE"),
      hasAlias: androidSecrets.has("_SIGN_ANDROID_KEY_ALIAS"),
      configured:
        androidSecrets.has("_SIGN_ANDROID_KEYSTORE") &&
        androidSecrets.has("_SIGN_ANDROID_KS_PASSWORD") &&
        androidSecrets.has("_SIGN_ANDROID_KEY_ALIAS"),
    },
  });
});

// ── POST /api/projects/:id/signing/ios ────────────────────────────────────────
router.post(
  "/projects/:id/signing/ios",
  requireProjectOwnership,
  async (req, res): Promise<void> => {
    const projectId = Number(req.params.id);
    if (!Number.isFinite(projectId)) {
      res.status(400).json({ error: "Invalid project id" });
      return;
    }

    const parsed = IosSigningSchema.safeParse(req.body);
    if (!parsed.success) {
      const first = parsed.error.errors[0];
      res.status(400).json({ error: first?.message ?? "Invalid input" });
      return;
    }

    const { p12Base64, p12Password, provisioningProfileBase64, teamId } = parsed.data;

    // Validate P12 magic bytes (PFX starts with 0x30 0x82 — base64: "MIIB" prefix common but not guaranteed)
    // We do a lightweight size check: a real P12 is at least 200 bytes encoded
    if (p12Base64.replace(/\s/g, "").length < 200) {
      res.status(400).json({ error: "P12 file appears too small — check that the file is valid" });
      return;
    }

    // Validate provisioning profile: should be base64 of binary plist (starts with "<?xml" or binary plist)
    if (provisioningProfileBase64.replace(/\s/g, "").length < 100) {
      res
        .status(400)
        .json({ error: "Provisioning profile appears too small — check that the file is valid" });
      return;
    }

    try {
      const writes: Array<[CredName, string]> = [
        ["_SIGN_IOS_P12_CERT", p12Base64.replace(/\s/g, "")],
        ["_SIGN_IOS_P12_PASSWORD", p12Password],
        ["_SIGN_IOS_PROVISIONING", provisioningProfileBase64.replace(/\s/g, "")],
      ];
      if (teamId) writes.push(["_SIGN_IOS_TEAM_ID", teamId]);

      await Promise.all(writes.map(([name, value]) => upsertSigningSecret(projectId, name, value)));

      logger.info({ projectId }, "iOS signing credentials saved");
      res.json({ ok: true, platform: "ios", saved: writes.map(([n]) => n) });
    } catch (err) {
      logger.error({ err, projectId }, "Failed to save iOS signing credentials");
      res.status(500).json({ error: "Failed to save signing credentials" });
    }
  },
);

// ── POST /api/projects/:id/signing/android ────────────────────────────────────
router.post(
  "/projects/:id/signing/android",
  requireProjectOwnership,
  async (req, res): Promise<void> => {
    const projectId = Number(req.params.id);
    if (!Number.isFinite(projectId)) {
      res.status(400).json({ error: "Invalid project id" });
      return;
    }

    const parsed = AndroidSigningSchema.safeParse(req.body);
    if (!parsed.success) {
      const first = parsed.error.errors[0];
      res.status(400).json({ error: first?.message ?? "Invalid input" });
      return;
    }

    const { keystoreBase64, keystorePassword, keyAlias, keyPassword } = parsed.data;

    if (keystoreBase64.replace(/\s/g, "").length < 100) {
      res
        .status(400)
        .json({ error: "Keystore file appears too small — check that the file is valid" });
      return;
    }

    try {
      const writes: Array<[CredName, string]> = [
        ["_SIGN_ANDROID_KEYSTORE", keystoreBase64.replace(/\s/g, "")],
        ["_SIGN_ANDROID_KS_PASSWORD", keystorePassword],
        ["_SIGN_ANDROID_KEY_ALIAS", keyAlias],
        ["_SIGN_ANDROID_KEY_PASSWORD", keyPassword || keystorePassword],
      ];

      await Promise.all(writes.map(([name, value]) => upsertSigningSecret(projectId, name, value)));

      logger.info({ projectId }, "Android signing credentials saved");
      res.json({ ok: true, platform: "android", saved: writes.map(([n]) => n) });
    } catch (err) {
      logger.error({ err, projectId }, "Failed to save Android signing credentials");
      res.status(500).json({ error: "Failed to save signing credentials" });
    }
  },
);

// ── DELETE /api/projects/:id/signing/ios ─────────────────────────────────────
router.delete(
  "/projects/:id/signing/ios",
  requireProjectOwnership,
  async (req, res): Promise<void> => {
    const projectId = Number(req.params.id);
    if (!Number.isFinite(projectId)) {
      res.status(400).json({ error: "Invalid project id" });
      return;
    }
    try {
      await deleteSigningSecrets(projectId, IOS_CRED_NAMES);
      logger.info({ projectId }, "iOS signing credentials removed");
      res.json({ ok: true, platform: "ios" });
    } catch (err) {
      logger.error({ err, projectId }, "Failed to remove iOS signing credentials");
      res.status(500).json({ error: "Failed to remove signing credentials" });
    }
  },
);

// ── DELETE /api/projects/:id/signing/android ──────────────────────────────────
router.delete(
  "/projects/:id/signing/android",
  requireProjectOwnership,
  async (req, res): Promise<void> => {
    const projectId = Number(req.params.id);
    if (!Number.isFinite(projectId)) {
      res.status(400).json({ error: "Invalid project id" });
      return;
    }
    try {
      await deleteSigningSecrets(projectId, ANDROID_CRED_NAMES);
      logger.info({ projectId }, "Android signing credentials removed");
      res.json({ ok: true, platform: "android" });
    } catch (err) {
      logger.error({ err, projectId }, "Failed to remove Android signing credentials");
      res.status(500).json({ error: "Failed to remove signing credentials" });
    }
  },
);

export default router;
