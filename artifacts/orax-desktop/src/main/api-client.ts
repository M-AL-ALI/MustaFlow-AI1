import type { PermissionMode } from "../shared/types";

const DEFAULT_BASE = "https://www.mustaflow.com";

export interface RegisterHostPayload {
  deviceName: string;
  platform: string;
  osVersion: string;
  appVersion: string;
  installId: string;
  publicKey: string;
  capabilities: Record<string, boolean>;
  metadata: Record<string, unknown>;
}

export interface RegisterHostResult {
  host: {
    id: string;
    deviceName: string;
    status: string;
    permissionMode: string;
  };
}

export interface PairingCodeResult {
  code: string;
  qrPayload: string;
  expiresAt: string;
}

export class OraxApiClient {
  private baseUrl: string;

  constructor(private getToken: () => Promise<string | null>) {
    this.baseUrl = process.env.ORAX_API_BASE_URL ?? DEFAULT_BASE;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const token = await this.getToken();
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "X-Client": "orax-desktop",
    };
    if (token) {
      headers["Authorization"] = `Bearer ${token}`;
    }

    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    if (!res.ok) {
      throw new Error(`[OraxAPI] ${method} ${path} → ${res.status}`);
    }
    return res.json() as Promise<T>;
  }

  async registerHost(payload: RegisterHostPayload): Promise<RegisterHostResult> {
    return this.request<RegisterHostResult>("POST", "/api/orax/hosts/register", payload);
  }

  async updateHost(
    hostId: string,
    patch: { permissionMode?: PermissionMode; deviceName?: string },
  ): Promise<void> {
    await this.request("PATCH", `/api/orax/hosts/${hostId}`, patch);
  }

  async heartbeat(hostId: string, appVersion: string): Promise<void> {
    await this.request("POST", "/api/orax/relay/heartbeat", { hostId, appVersion });
  }

  async createPairingCode(hostId: string): Promise<PairingCodeResult> {
    return this.request<PairingCodeResult>("POST", "/api/orax/pairing-codes", { hostId });
  }

  async cancelPairingCode(code: string): Promise<void> {
    await this.request("DELETE", `/api/orax/pairing-codes/${encodeURIComponent(code)}`);
  }

  async getPendingActions(hostId: string): Promise<{
    actions: Array<{
      id: string;
      type: string;
      idempotencyKey: string;
      payload: Record<string, unknown>;
      status: string;
    }>;
  }> {
    return this.request<{
      actions: Array<{
        id: string;
        type: string;
        idempotencyKey: string;
        payload: Record<string, unknown>;
        status: string;
      }>;
    }>("GET", `/api/orax/relay/pending-actions?hostId=${encodeURIComponent(hostId)}`);
  }

  async postActionEvent(
    actionId: string,
    type: "acknowledged" | "running" | "progress" | "completed" | "failed",
    payload: Record<string, unknown>,
  ): Promise<void> {
    await this.request("POST", `/api/orax/relay/actions/${encodeURIComponent(actionId)}/events`, {
      type,
      payload,
    });
  }
}
