export interface AuthSession {
  userId: string;
  email: string;
  displayName: string;
  token: string;
}

export type HostStatus = "unregistered" | "online" | "offline" | "reconnecting";

export const PERMISSION_MODES = [
  "read_only",
  "ask_everything",
  "ask_risky",
  "trusted_project",
  "full_access",
  "custom",
] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];

export const PERMISSION_MODE_LABELS: Record<PermissionMode, string> = {
  read_only: "Read Only",
  ask_everything: "Ask Before Everything",
  ask_risky: "Ask for Risky Actions (default)",
  trusted_project: "Trusted Project Mode",
  full_access: "Full Access",
  custom: "Custom",
};

export interface HostState {
  hostId: string | null;
  status: HostStatus;
  permissionMode: PermissionMode;
  deviceName: string;
  platform: string;
  appVersion: string;
}

export interface PairingState {
  code: string | null;
  qrPayload: string | null;
  expiresAt: string | null;
  isActive: boolean;
}

export interface LocalProject {
  id: string;
  displayName: string;
  localPath: string;
  addedAt: string;
}

export type RelayStatus = "idle" | "polling" | "error";

export interface RelayState {
  status: RelayStatus;
  lastPollAt: string | null;
  errorMsg: string | null;
}
