import { eq } from "drizzle-orm";
import {
  db,
  notificationsTable,
  supportUserDeliveriesTable,
  type SupportDeliveryKind,
  type SupportDeliveryStatus,
  type SupportUserDelivery,
} from "@workspace/db";
import { sendEmailWithStatus } from "./emailClient";

type SupportEmail = {
  subject: string;
  html: string;
  text: string;
};

const SUPPORT_EMAIL_DELIVERY_TIMEOUT_MS = 8_000;

export type DeliverSupportConsequenceInput = {
  ticketId: number;
  projectId: number | null;
  recipientUserId: string;
  recipientEmail: string | null;
  actorUserId: string;
  actorName?: string | null;
  kind: SupportDeliveryKind;
  notification: {
    type: string;
    title: string;
    body: string;
    metadata?: Record<string, unknown>;
  };
  email: SupportEmail;
};

export function supportProductUrl(path: string): string {
  const configured = process.env.WEB_BASE_URL?.trim() || process.env.PLATFORM_DOMAIN?.trim();
  const base =
    configured && /^https:\/\//u.test(configured) ? configured : "https://www.mustaflow.com";
  return `${base.replace(/\/+$/u, "")}/${path.replace(/^\/+/, "")}`;
}

/**
 * Persist the in-product notification and a pending cross-channel receipt
 * before attempting email. The request does not claim success until the
 * durable row has been updated to sent or failed.
 */
export async function deliverSupportConsequence(
  input: DeliverSupportConsequenceInput,
): Promise<SupportUserDelivery & { emailStatus: SupportDeliveryStatus }> {
  const pending = await db.transaction(async (tx) => {
    const [notification] = await tx
      .insert(notificationsTable)
      .values({
        recipientId: input.recipientUserId,
        type: input.notification.type,
        title: input.notification.title,
        body: input.notification.body,
        actorId: input.actorUserId,
        actorName: input.actorName ?? null,
        resourceType: "support_ticket",
        resourceId: String(input.ticketId),
        projectId: input.projectId,
        metadata: {
          ...(input.notification.metadata ?? {}),
          ticketId: input.ticketId,
        },
      })
      .returning({ id: notificationsTable.id });
    const [delivery] = await tx
      .insert(supportUserDeliveriesTable)
      .values({
        ticketId: input.ticketId,
        projectId: input.projectId,
        recipientUserId: input.recipientUserId,
        recipientEmail: input.recipientEmail,
        kind: input.kind,
        notificationId: notification!.id,
        emailStatus: "pending",
      })
      .returning();
    return delivery!;
  });

  const providerSignal = AbortSignal.timeout(SUPPORT_EMAIL_DELIVERY_TIMEOUT_MS);
  const providerStatus = input.recipientEmail
    ? await sendEmailWithStatus({
        to: input.recipientEmail,
        ...input.email,
        signal: providerSignal,
        idempotencyKey: `support-delivery:${pending.id}`,
      })
    : "failed";
  if (providerSignal.aborted) {
    // The provider may have accepted the request before its response was lost.
    // Keep the durable receipt pending rather than claiming sent or failed; the
    // idempotency key makes a governed retry safe.
    return { ...pending, emailStatus: "pending" };
  }
  const emailStatus: SupportDeliveryStatus = providerStatus === "sent" ? "sent" : "failed";
  const emailFailureReason =
    providerStatus === "skipped"
      ? "Email delivery is not configured."
      : providerStatus === "failed"
        ? input.recipientEmail
          ? "The email provider did not accept the message."
          : "No email address is on file."
        : null;
  const [completed] = await db
    .update(supportUserDeliveriesTable)
    .set({ emailStatus, emailFailureReason, completedAt: new Date() })
    .where(eq(supportUserDeliveriesTable.id, pending.id))
    .returning();
  if (!completed) throw new Error("support_delivery_receipt_update_failed");
  return { ...completed, emailStatus };
}
