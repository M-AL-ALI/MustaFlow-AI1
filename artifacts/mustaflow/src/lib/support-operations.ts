import { authFetch } from "@/lib/api-fetch";

export type SupportGrantView = {
  id: number;
  ticketId: number;
  projectId: number;
  staffUserId: string;
  reason: string;
  status: string;
  requestedAt: string;
  expiresAt?: string | null;
};

export type SupportZeroSessionView = {
  id: number;
  ticketId: number;
  grantId: number;
  projectId: number;
  staffUserId: string;
  status: string;
  evidenceBundle: Record<string, unknown>;
  proposal: Record<string, unknown>;
  taskId?: number | null;
  appliedVersionId?: number | null;
  terminal?: Record<string, unknown> | null;
  createdAt: string;
  completedAt?: string | null;
};

export type PlatformDefectView = {
  id: number;
  title: string;
  status: string;
  shippedVersion?: string | null;
};

export type SupportGrantEventView = {
  id: number;
  grantId: number;
  actorUserId: string;
  actorDisplayName?: string | null;
  event: string;
  detail: Record<string, unknown>;
  createdAt: string;
};

export type PlatformDefectImpactView = {
  defectId: number;
  affectedAccountCount: number;
  affectedAccounts: string[];
  linkedTicketCount: number;
};

export type SupportUserDeliveryView = {
  id: number;
  ticketId: number;
  projectId?: number | null;
  kind: string;
  emailStatus: "pending" | "sent" | "delivered" | "failed";
  emailFailureReason?: string | null;
  createdAt: string;
  completedAt?: string | null;
};

export function presentSupportEmailStatus(status: SupportUserDeliveryView["emailStatus"]): string {
  switch (status) {
    case "pending":
      return "email pending";
    case "sent":
      return "email accepted by provider";
    case "delivered":
      return "email delivered";
    case "failed":
      return "email failed";
  }
}

export type SupportOperationsView = {
  ticket: {
    id: number;
    status: string;
    resolutionClass?: "project" | "platform" | "external" | null;
    thirdPartyBlocker?: string | null;
    resolutionEvidence?: Record<string, unknown> | null;
    projectId?: number | null;
  };
  grants: SupportGrantView[];
  grantEvents: SupportGrantEventView[];
  sessions: SupportZeroSessionView[];
  defects: PlatformDefectView[];
  defectImpact?: PlatformDefectImpactView[];
  deliveries: SupportUserDeliveryView[];
};

async function apiJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await authFetch(path, {
    ...init,
    headers: {
      ...(init?.body ? { "content-type": "application/json" } : {}),
      ...init?.headers,
    },
  });
  const body = (await response.json().catch(() => null)) as (T & { error?: string }) | null;
  if (!response.ok || !body) {
    throw new Error(body?.error ?? "NabuFlow could not complete that support action.");
  }
  return body;
}

export function getAdminSupportOperations(ticketId: number): Promise<SupportOperationsView> {
  return apiJson(`/api/admin/support-tickets/${ticketId}/operations`);
}

export function getOwnerSupportOperations(ticketId: number): Promise<SupportOperationsView> {
  return apiJson(`/api/support/tickets/${ticketId}/operations`);
}

export function postSupportOperation<T>(path: string, data?: unknown): Promise<T> {
  return apiJson(path, {
    method: "POST",
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
  });
}
