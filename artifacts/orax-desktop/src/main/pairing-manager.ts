import type { OraxApiClient } from "./api-client";
import type { PairingState } from "../shared/types";

export class PairingManager {
  private state: PairingState = {
    code: null,
    qrPayload: null,
    expiresAt: null,
    isActive: false,
  };
  private onChange: ((state: PairingState) => void) | null = null;

  constructor(private api: OraxApiClient) {}

  setOnChange(cb: (state: PairingState) => void): void {
    this.onChange = cb;
  }

  getState(): PairingState {
    return { ...this.state };
  }

  async createCode(hostId: string): Promise<PairingState> {
    const result = await this.api.createPairingCode(hostId);
    this.state = {
      code: result.code,
      qrPayload: result.qrPayload,
      expiresAt: result.expiresAt,
      isActive: true,
    };
    this.emit();
    return this.getState();
  }

  async cancelCode(): Promise<void> {
    if (!this.state.code) return;
    const code = this.state.code;
    this.clearState();
    try {
      await this.api.cancelPairingCode(code);
    } catch (err) {
      console.error("[PairingManager] cancel error:", err);
    }
  }

  clearState(): void {
    this.state = { code: null, qrPayload: null, expiresAt: null, isActive: false };
    this.emit();
  }

  private emit(): void {
    this.onChange?.({ ...this.state });
  }
}
