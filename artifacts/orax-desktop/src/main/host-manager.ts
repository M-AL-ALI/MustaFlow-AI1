import type { OraxApiClient, RegisterHostPayload } from "./api-client";
import type { InstallIdentity } from "./install-identity";
import type { HostState, PermissionMode } from "../shared/types";

const HEARTBEAT_INTERVAL_MS = 30_000;

export class HostManager {
  private state: HostState;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private onChange: ((state: HostState) => void) | null = null;

  constructor(
    private api: OraxApiClient,
    private identity: InstallIdentity,
  ) {
    this.state = {
      hostId: null,
      status: "unregistered",
      permissionMode: "ask_risky",
      deviceName: identity.deviceName,
      platform: identity.platform,
      appVersion: identity.appVersion,
    };
  }

  setOnChange(cb: (state: HostState) => void): void {
    this.onChange = cb;
  }

  getState(): HostState {
    return { ...this.state };
  }

  async register(): Promise<HostState> {
    const payload: RegisterHostPayload = {
      deviceName: this.identity.deviceName,
      platform: this.identity.platform,
      osVersion: this.identity.osVersion,
      appVersion: this.identity.appVersion,
      installId: this.identity.installId,
      publicKey: "",
      capabilities: {
        shell: false,
        filesystem: false,
        git: false,
        github: false,
        browser: false,
        screenshot: false,
        computer_use: false,
      },
      metadata: { appVersion: this.identity.appVersion },
    };

    const result = await this.api.registerHost(payload);
    this.state.hostId = result.host.id;
    this.state.permissionMode = result.host.permissionMode as PermissionMode;
    this.state.status = "online";
    this.emit();
    this.startHeartbeat();
    return this.getState();
  }

  async updatePermissionMode(mode: PermissionMode): Promise<void> {
    if (!this.state.hostId) throw new Error("Host not registered");
    await this.api.updateHost(this.state.hostId, { permissionMode: mode });
    this.state.permissionMode = mode;
    this.emit();
  }

  private startHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = setInterval(() => {
      void this.sendHeartbeat();
    }, HEARTBEAT_INTERVAL_MS);
    this.heartbeatTimer.unref?.();
  }

  private async sendHeartbeat(): Promise<void> {
    if (!this.state.hostId) return;
    try {
      await this.api.heartbeat(this.state.hostId, this.identity.appVersion);
      if (this.state.status !== "online") {
        this.state.status = "online";
        this.emit();
      }
    } catch {
      this.state.status = this.state.status === "reconnecting" ? "offline" : "reconnecting";
      this.emit();
    }
  }

  stop(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private emit(): void {
    this.onChange?.({ ...this.state });
  }
}
