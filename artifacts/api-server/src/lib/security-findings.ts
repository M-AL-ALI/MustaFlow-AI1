/**
 * Security Findings helper
 *
 * Upserts persistent security findings from a check run result.
 * Uses fingerprint (hash of checkType+file+message) as the deduplication key.
 * Marks findings as "fixed" when their fingerprint is absent from the latest run.
 */
import { createHash } from "crypto";
import { eq, and, notInArray, inArray, isNull, count } from "drizzle-orm";
import { db, securityFindingsTable, projectsTable } from "@workspace/db";
import type { CheckFinding } from "@workspace/db";
import { logger } from "./logger";

export type SecuritySeverity = "critical" | "high" | "medium" | "low" | "info";

/** Map check-run severity to security severity level */
function mapSeverity(checkType: string, severity: CheckFinding["severity"]): SecuritySeverity {
  if (severity === "error") {
    if (checkType === "secret-leak" || checkType === "sast") return "critical";
    return "high";
  }
  if (severity === "warning") return "medium";
  return "low";
}

/** Build a stable fingerprint for deduplication */
function makeFingerprint(checkType: string, file: string, message: string): string {
  return createHash("sha256")
    .update(`${checkType}::${file ?? ""}::${message}`)
    .digest("hex")
    .slice(0, 40);
}

export interface FindingInput {
  checkType: string;
  checkRunId: number | null;
  findings: CheckFinding[];
}

/**
 * Upsert all findings from a completed check run into the persistent findings table.
 * After upserting active findings, marks all previously-open findings whose
 * fingerprints are NOT in the current run as "fixed".
 */
export async function persistSecurityFindings(
  projectId: number,
  inputs: FindingInput[],
): Promise<void> {
  try {
    const activeFingerprints: string[] = [];
    const now = new Date();

    for (const { checkType, checkRunId, findings } of inputs) {
      for (const finding of findings) {
        const fingerprint = makeFingerprint(checkType, finding.file ?? "", finding.message);
        activeFingerprints.push(fingerprint);
        const severity = mapSeverity(checkType, finding.severity);

        await db
          .insert(securityFindingsTable)
          .values({
            projectId,
            checkRunId: checkRunId ?? undefined,
            checkType,
            severity,
            fingerprint,
            message: finding.message,
            file: finding.file ?? null,
            line: finding.line ?? null,
            status: "open",
            firstSeenAt: now,
            lastSeenAt: now,
          })
          .onConflictDoUpdate({
            target: [securityFindingsTable.projectId, securityFindingsTable.fingerprint],
            set: {
              lastSeenAt: now,
              status: "open",
              checkRunId: checkRunId ?? undefined,
              line: finding.line ?? null,
            },
          });
      }
    }

    // Mark findings not seen in this run as "fixed" (only open ones)
    if (activeFingerprints.length > 0) {
      await db
        .update(securityFindingsTable)
        .set({ status: "fixed" })
        .where(
          and(
            eq(securityFindingsTable.projectId, projectId),
            eq(securityFindingsTable.status, "open"),
            notInArray(securityFindingsTable.fingerprint, activeFingerprints),
          ),
        );
    }
  } catch (err) {
    logger.warn({ err, projectId }, "persistSecurityFindings: non-fatal error");
  }
}

/**
 * Get all open critical+high counts for a user's projects (for sidebar badge)
 */
export async function getAccountSecurityBadgeCount(userId: string): Promise<number> {
  try {
    const rows = await db
      .select({ total: count() })
      .from(securityFindingsTable)
      .innerJoin(projectsTable, eq(securityFindingsTable.projectId, projectsTable.id))
      .where(
        and(
          eq(projectsTable.ownerId, userId),
          eq(securityFindingsTable.status, "open"),
          inArray(securityFindingsTable.severity, ["critical", "high"]),
          isNull(projectsTable.deletedAt),
        ),
      );
    return Number(rows[0]?.total ?? 0);
  } catch {
    return 0;
  }
}
